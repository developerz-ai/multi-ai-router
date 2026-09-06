import type { WireEvent } from "../render/events"
import type { Turn } from "../render/index-map"
import { unprefixToolName } from "./names"
import { repairToolInput } from "./repair"
import type { ToolSchema } from "./schema"

/**
 * The two edits a `tool_use` block needs before the client can execute it.
 *
 * **The name.** The SDK knows a client tool as `mcp__client__get_weather`; the client knows
 * `get_weather` and matches its `tool_result` on that. The prefix comes off here, in the stream,
 * because that is the copy the client actually parses (`names.ts`).
 *
 * **The argument names.** Claude Code's own prompt teaches `snake_case`, so a client declaring
 * `filePath` gets `file_path` and the call fails on the far side. `repair.ts` decides *whether* to
 * rename; this module is what makes the repaired input reach the wire.
 *
 * **And that costs one buffer, deliberately.** A tool's arguments arrive as `input_json_delta`
 * fragments that split mid-key, so no per-chunk rewrite is possible — the input is not a document
 * until `content_block_stop`. So a tool block's deltas are held and re-emitted as one, and *only* a
 * tool block's: text and thinking stream through untouched, which is where time-to-first-token
 * actually lives. This is the Agent-SDK path's labeled exception to "never buffer a stream", already
 * granted because nothing on this path is a relay in the first place (non-negotiable 8, §6).
 *
 * Nothing is ever dropped. Arguments that do not parse as JSON, or that outgrow the buffer bound,
 * are forwarded exactly as the model spelled them: a client that can make sense of them still can,
 * and a router that swallowed them would have turned a fidelity gap into a lost tool call.
 *
 * **"Nothing is ever dropped" needs {@link ToolRewriter.flush} to be true, and for a while it was
 * not.** The hold is released by `content_block_stop`, and the early stop ends the SDK loop the
 * instant every emitted call has been denied (`early-stop.ts`) — a race the stop sometimes wins. The
 * held fragments then died with the loop, and the client received a `tool_use` block carrying its
 * name, its id, and **no arguments at all**: `arguments: ""` on the openai wire, which is not JSON,
 * so the client's reader threw before it could run anything. Measured at ~1.4% of requests under
 * agent load, always exactly one block, and fatal to the whole turn every time (2026-09-06). So the
 * stream ending is now an ending the rewriter is *told* about, and it says what it was still
 * holding.
 */

/** A JSON object as it goes back onto the wire. */
type WireRecord = Record<string, unknown>

/** Forward the event untouched, or replace it with zero, one, or two of our own. */
export type ToolRewrite =
  | { readonly kind: "forward" }
  | { readonly kind: "replace"; readonly events: readonly WireRecord[] }

const FORWARD: ToolRewrite = { kind: "forward" }
const HOLD: ToolRewrite = { kind: "replace", events: [] }

/**
 * How much argument JSON is held before a block gives up on repair and streams the rest.
 *
 * A bound on memory per in-flight block, not a limit on what a tool may be passed: past it the
 * buffered prefix is flushed and every later fragment forwarded as it arrives, so an oversized call
 * still reaches the client in full — just unrepaired.
 */
export const MAX_BUFFERED_TOOL_INPUT = 1024 * 1024

/** A `tool_use` block the model opened on the turn the client asked for. */
export interface EmittedToolCall {
  readonly id: string
  /** The **client's** name, already un-prefixed. */
  readonly name: string
}

export interface ToolRewriter {
  /** @returns what to put on the wire in place of `event`. Never throws. */
  push(event: WireEvent, turn: Turn): ToolRewrite
  /** Every `tool_use` block opened on the client's own turn, in order. */
  readonly calls: readonly EmittedToolCall[]
  /** Calls whose arguments arrived empty though the tool declares required ones. */
  readonly emptyInput: readonly string[]
  /**
   * The stream ended. @returns the events every still-open tool block is still owed — its held
   * arguments, then its `content_block_stop` — in the order the blocks were opened.
   *
   * Empty in an ordinary turn: a block that closed on the wire released its own hold and is no
   * longer open. Non-empty exactly when the loop ended mid-block, which is the early stop winning
   * its race, and then this is the difference between a client running the model's tool call and a
   * client throwing on `JSON.parse("")`.
   *
   * @param complete the arguments the `PreToolUse` hook saw, by tool-call id. Preferred over the
   * held buffer, and not because it is more convenient: the hook is handed the input **assembled**,
   * while the buffer holds only the fragments that reached us before the loop ended — so the buffer
   * can be a truncated prefix of valid JSON, and the hook's copy is the call the SDK actually
   * dispatched. Using it is reporting what the model asked for, not inventing it.
   */
  flush(complete?: ReadonlyMap<string, unknown>): readonly WireRecord[]
}

interface OpenTool {
  readonly id: string
  readonly name: string
  readonly index: number
  /** `content_block_start`'s own `input`, used when the model sent no fragments at all. */
  readonly seed: WireRecord | null
  buffer: string
  /** Past the bound: fragments now stream through and this block is not repaired. */
  overflowed: boolean
}

/** @param schemas the client's declarations, keyed by the client's own tool name. */
export function createToolRewriter(schemas: ReadonlyMap<string, ToolSchema>): ToolRewriter {
  const open = new Map<number, OpenTool>()
  const calls: EmittedToolCall[] = []
  const emptyInput: string[] = []

  /** @returns the repaired input, or the argument unchanged when there was nothing to repair. */
  const repair = (name: string, input: WireRecord | null): WireRecord | null => {
    const schema = schemas.get(name)
    if (input === null || schema === undefined) return input
    return repairToolInput(input, schema).input
  }

  const start = (event: WireEvent, index: number): ToolRewrite => {
    const block = asRecord(event.raw.content_block)
    if (block === null || block.type !== "tool_use") return FORWARD

    const name = unprefixToolName(typeof block.name === "string" ? block.name : "")
    const id = typeof block.id === "string" ? block.id : ""
    // The start's own `input` is complete when it is present at all, so it is repaired here rather
    // than held: only the fragment stream needs an ending to wait for.
    const seed = repair(name, asRecord(block.input))
    calls.push({ id, name })
    open.set(index, { id, name, index, seed, buffer: "", overflowed: false })

    return {
      kind: "replace",
      events: [{ ...event.raw, content_block: { ...block, name, input: seed ?? block.input } }],
    }
  }

  const delta = (event: WireEvent, index: number): ToolRewrite => {
    const tool = open.get(index)
    if (tool === undefined || tool.overflowed) return FORWARD

    const fragment = asRecord(event.raw.delta)
    if (fragment?.type !== "input_json_delta") return FORWARD
    tool.buffer += typeof fragment.partial_json === "string" ? fragment.partial_json : ""

    if (tool.buffer.length <= MAX_BUFFERED_TOOL_INPUT) return HOLD
    tool.overflowed = true
    return { kind: "replace", events: [inputDelta(index, tool.buffer)] }
  }

  const stop = (event: WireEvent, index: number): ToolRewrite => {
    const tool = open.get(index)
    if (tool === undefined) return FORWARD
    open.delete(index)

    const noteIfEmpty = (input: WireRecord | null): void => {
      const declared = schemas.get(tool.name)?.required.length ?? 0
      if (declared > 0 && Object.keys(input ?? {}).length === 0) emptyInput.push(tool.id)
    }

    // Nothing was held, so there is nothing to re-emit: the block already reached the client whole.
    if (tool.overflowed) return FORWARD
    if (tool.buffer.length === 0) {
      noteIfEmpty(tool.seed)
      return FORWARD
    }

    const parsed = parseObject(tool.buffer)
    if (parsed === null) {
      // Unparseable, and therefore unrepairable — but still the model's answer. Verbatim.
      return { kind: "replace", events: [inputDelta(index, tool.buffer), stopFrame(event, index)] }
    }

    const input = repair(tool.name, parsed) ?? parsed
    noteIfEmpty(input)
    return {
      kind: "replace",
      events: [inputDelta(index, JSON.stringify(input)), stopFrame(event, index)],
    }
  }

  /** The arguments a still-open block should be closed with, best source first. */
  const closingInput = (tool: OpenTool, complete?: ReadonlyMap<string, unknown>): string | null => {
    const captured = asRecord(complete?.get(tool.id))
    if (captured !== null) return JSON.stringify(repair(tool.name, captured) ?? captured)
    if (tool.buffer.length === 0) return null
    const parsed = parseObject(tool.buffer)
    // Unparseable is still the model's answer, forwarded verbatim — the same rule `stop` follows.
    return parsed === null ? tool.buffer : JSON.stringify(repair(tool.name, parsed) ?? parsed)
  }

  return {
    flush(complete) {
      const events: WireRecord[] = []
      // Index order rather than insertion order: the envelope closes what it holds open, and the
      // two must agree about which block each event addresses.
      for (const [index, tool] of [...open.entries()].sort(([a], [b]) => a - b)) {
        open.delete(index)
        // An overflowed block already streamed its fragments; only its ending was lost.
        const input = tool.overflowed ? null : closingInput(tool, complete)
        if (input !== null) events.push(inputDelta(index, input))
        events.push({ type: "content_block_stop", index })
      }
      return events
    },

    push(event, turn) {
      // A subagent's blocks are a conversation the client never asked for; the envelope drops them
      // whole. Rewriting them would spend the buffer on output nobody will ever read.
      if (turn !== null || event.index === null) return FORWARD

      switch (event.type) {
        case "content_block_start":
          return start(event, event.index)
        case "content_block_delta":
          return delta(event, event.index)
        case "content_block_stop":
          return stop(event, event.index)
        default:
          return FORWARD
      }
    },
    calls,
    emptyInput,
  }
}

function inputDelta(index: number, partialJson: string): WireRecord {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  }
}

/** The SDK's own stop, forwarded — the index is rewritten downstream, by the envelope's map. */
function stopFrame(event: WireEvent, index: number): WireRecord {
  return { ...event.raw, type: "content_block_stop", index }
}

function parseObject(text: string): WireRecord | null {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

function asRecord(value: unknown): WireRecord | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
