import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk"
import { toolDenial } from "../allowlist"
import { readSdkMessage, readWireEvent } from "../render/events"
import { unprefixToolName } from "./names"
import type { ToolRewriter } from "./rewrite"

/**
 * Making an autonomous agent behave like a single-turn endpoint, once it has asked to use a tool.
 *
 * A `POST /v1/messages` that ends in `tool_use` is *finished*: the client executes the call and
 * comes back with a `tool_result` next turn. The SDK does not work that way. It denies the call
 * (because we deny it), feeds itself the refusal, and runs another fully billed turn digesting it —
 * on an always-thinking model, a thinking pass per denied call — before answering something the
 * client never asked. Three mechanisms turn that back into one turn
 * (docs/idea/11-anthropic-agent-sdk.md §7):
 *
 * - **Capture.** A `PreToolUse` hook sees every call, denies it, and records it. The hook is the
 *   only surface that observes a call the stream never carried, so it is also the integrity check
 *   on the stream: a captured call the client did not receive is a bug that is otherwise silent.
 * - **Deny-hold.** A deny that lands while later parallel blocks are still generating makes the CLI
 *   cancel the in-flight request and truncate them. So a deny waits for the turn's `message_delta`
 *   — the point after which there is nothing left to truncate.
 * - **Early stop.** Once every call the model emitted has been denied, the digest turn buys nothing
 *   and costs a full turn's tokens. The subprocess is terminated and the loop ends as
 *   `stop_reason: "tool_use"`, which is what it actually was.
 *
 * **Turn-2 suppression is the backstop**, for the runs where the SDK opens the next turn before the
 * last deny is in. Everything after the second `message_start` is dropped and the same terminal
 * stop reason is stated. It is conditioned on the model having emitted a tool call, because without
 * one a second turn is the SDK doing something we have no reason to truncate.
 *
 * **`stop_reason: "tool_use"` is a fact, not a fabrication.** The model emitted the calls, the
 * client is being handed them, and the turn is over — that is the honest reading, and §6's
 * prohibition is on inventing *content*, which nothing here does. The cost of stopping early is the
 * SDK's authoritative `result` usage, so the counts fall back to the last `message_delta`'s: the
 * tokens for the turn the client actually received, which is the truthful bill for it.
 */

/**
 * Seconds the SDK waits on a held deny before timing the hook out.
 *
 * A ceiling on a hold that is normally microseconds — `message_delta` precedes tool dispatch in
 * every ordinary run — so it exists for the runs that are not ordinary. Generous rather than tight:
 * expiring early re-opens the truncation the hold prevents, while expiring late costs nothing,
 * because the attempt deadline and the renderer's idle guard both bound the request already.
 */
export const DENY_HOLD_TIMEOUT_SECONDS = 60

/** A tool call the model asked the SDK to run, as the `PreToolUse` hook saw it. */
export interface CapturedToolCall {
  readonly id: string
  /** The **client's** name, already un-prefixed. */
  readonly name: string
  /** The complete arguments — the hook sees them assembled, unlike the stream. */
  readonly input: unknown
}

/**
 * What the turn's tool handling got wrong, if anything. Both fields are silent-bug detectors: a
 * client cannot tell a dropped call from a model that never made one, and neither can a log line.
 */
export interface ToolIntegrity {
  readonly emitted: number
  readonly captured: number
  /** Block ids the client was sent that no hook ever saw — a call the SDK never dispatched. */
  readonly uncaptured: readonly string[]
  /** Block ids whose arguments arrived empty though the tool declares required ones. */
  readonly emptyInput: readonly string[]
}

export interface EarlyStopInput {
  readonly rewriter: ToolRewriter
  /** Terminates the subprocess. Called at most once, and only for an early stop. */
  readonly abort?: () => void
  readonly holdTimeoutSeconds?: number
}

export interface EarlyStop {
  /** Merge into `Options.hooks`. Unmatched, so it sees every tool call the SDK dispatches. */
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  /**
   * Wraps the SDK's message stream. The renderer reads the wrapper, so suppression and rewriting
   * happen before re-synthesis rather than inside it — one agent loop, two modules, no shared state.
   */
  filter(messages: AsyncIterable<unknown>): AsyncIterable<unknown>
  readonly captures: readonly CapturedToolCall[]
  integrity(): ToolIntegrity
}

/**
 * The `result` a stopped loop never sent. `usage` is deliberately absent: the renderer falls back to
 * the last `message_delta`'s counts, and a zero written here would be an invented number.
 */
const TOOL_USE_RESULT = { type: "result", subtype: "success", stop_reason: "tool_use" } as const

/** Distinguishes "the stop fired" from any value the SDK could yield. */
const STOPPED = Symbol("early-stop")

export function createEarlyStop(input: EarlyStopInput): EarlyStop {
  const rewriter = input.rewriter
  const captures: CapturedToolCall[] = []
  const capturedIds = new Set<string>()
  const holds: (() => void)[] = []

  let released = false
  let stopped = false
  let mainStarts = 0

  let fireStop: () => void = () => {}
  const stopped$ = new Promise<typeof STOPPED>((resolve) => {
    fireStop = () => resolve(STOPPED)
  })

  const release = (): void => {
    released = true
    for (const resolve of holds.splice(0)) resolve()
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    release()
    fireStop()
    try {
      input.abort?.()
    } catch {
      // The subprocess is already gone, which is the state the abort was asking for.
    }
  }

  /** Every emitted call denied, and nothing still generating. The digest turn buys nothing. */
  const settled = (): boolean =>
    released && rewriter.calls.length > 0 && rewriter.calls.every((c) => capturedIds.has(c.id))

  const hold = (signal: AbortSignal): Promise<void> => {
    if (released || signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done)
        resolve()
      }
      holds.push(done)
      signal.addEventListener("abort", done, { once: true })
    })
  }

  const preToolUse: HookCallback = async (hookInput, _toolUseId, options) => {
    const call = readToolCall(hookInput)
    if (call !== null) {
      captures.push(call)
      capturedIds.add(call.id)
    }
    await hold(options.signal)
    if (settled()) stop()
    return denial(call?.name ?? null)
  }

  const step = (value: unknown): readonly unknown[] => {
    const message = readSdkMessage(value)
    if (message === null || message.type !== "stream_event") return [value]
    const event = readWireEvent(message.event)
    if (event === null) return [value]
    const turn = message.parentToolUseId

    if (event.type === "message_start" && turn === null) {
      mainStarts += 1
      if (mainStarts > 1 && rewriter.calls.length > 0) {
        stop()
        return []
      }
    }

    const rewrite = rewriter.push(event, turn)
    const out = rewrite.kind === "forward" ? [value] : rewrite.events.map((e) => rewrap(value, e))

    // The turn is fully generated: there is nothing left for a deny to truncate.
    if (event.type === "message_delta" && turn === null) {
      release()
      if (settled()) stop()
    }
    return out
  }

  const pull = async (iterator: AsyncIterator<unknown>): Promise<IteratorResult<unknown>> => {
    try {
      return await iterator.next()
    } catch (error) {
      // Terminating the subprocess is how an early stop is delivered, so the failure it raises is
      // this module's own doing. Anything else is the request's, and is rethrown.
      if (!stopped) throw error
      return { done: true, value: undefined }
    }
  }

  async function* filter(messages: AsyncIterable<unknown>): AsyncIterable<unknown> {
    const iterator = messages[Symbol.asyncIterator]()
    try {
      for (;;) {
        const next = await Promise.race([pull(iterator), stopped$])
        if (next === STOPPED || next.done === true) break
        for (const out of step(next.value)) yield out
        if (stopped) break
      }
    } finally {
      // A held deny must never outlive the stream: the SDK would wait on a turn that has ended.
      release()
      iterator.return?.().catch(() => {})
    }

    // **Whatever the rewriter was still holding, before the loop's ending is announced.**
    //
    // A tool block's arguments are buffered until its `content_block_stop` (`rewrite.ts`), and every
    // exit above can happen first — the early stop is a race against that stop and sometimes wins.
    // The held fragments used to die here, and the client received a `tool_use` block with its name,
    // its id, and no arguments at all: `arguments: ""` on the openai wire, which is not JSON, so the
    // client's reader threw before it could run anything (2026-09-06).
    //
    // The hook's copy of the input is preferred over the buffer because it is the assembled one —
    // the buffer holds only the fragments that arrived before the loop ended, and a truncated prefix
    // of valid JSON is still not valid JSON.
    // **Wrapped explicitly, never against the loop's last message.** The renderer discriminates on
    // the SDK message's `type` (`render/events.ts`), and the first cut of this flush reused
    // `rewrap` with whatever message the loop happened to end on. When that was an `assistant`
    // message — routinely the last thing the SDK sends — the flushed events came out typed
    // `assistant` with a wire event stapled to them, the renderer never looked inside, and the
    // block stayed open exactly as if the flush had never run. Production, 2026-09-06:
    // `blocks: 1, kinds: ["tool_use"], lastMessage: "assistant", declaredTools: 12,
    // passthrough: true` — every part of the machinery working and the last inch undoing it.
    //
    // `parent_tool_use_id: null` is a fact rather than a default: the rewriter only ever holds
    // blocks from the turn the client asked for, because `push` forwards a subagent's untouched.
    const complete = new Map(captures.map((call) => [call.id, call.input]))
    for (const event of rewriter.flush(complete)) {
      yield { type: "stream_event", event, parent_tool_use_id: null }
    }

    if (stopped) yield TOOL_USE_RESULT
  }

  return {
    hooks: {
      PreToolUse: [
        { hooks: [preToolUse], timeout: input.holdTimeoutSeconds ?? DENY_HOLD_TIMEOUT_SECONDS },
      ],
    },
    filter,
    captures,
    integrity: () => ({
      emitted: rewriter.calls.length,
      captured: captures.length,
      uncaptured: rewriter.calls.filter((c) => !capturedIds.has(c.id)).map((c) => c.id),
      emptyInput: [...rewriter.emptyInput],
    }),
  }
}

/** @returns null for any hook event other than the one this module registers for. */
function readToolCall(hookInput: HookInput): CapturedToolCall | null {
  if (hookInput.hook_event_name !== "PreToolUse") return null
  return {
    id: hookInput.tool_use_id,
    name: unprefixToolName(hookInput.tool_name),
    input: hookInput.tool_input,
  }
}

/**
 * Denies without ending the turn. The model's next legal move is to leave the call in its answer for
 * the client to run, and interrupting would take that away; the loop is bounded by the stop above,
 * not by refusing loudly.
 */
function denial(name: string | null): HookJSONOutput {
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: toolDenial(name ?? "that tool"),
    },
  }
}

/** The SDK message, carrying a rewritten event. Everything else about it is left as it arrived. */
function rewrap(message: unknown, event: Record<string, unknown>): unknown {
  if (typeof message !== "object" || message === null) return { type: "stream_event", event }
  return { ...message, event }
}
