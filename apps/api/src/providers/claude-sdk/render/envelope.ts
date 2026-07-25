import { readMessageFacts, readStopFacts, readUsage, type SdkUsage, type WireEvent } from "./events"
import { createBlockIndexMap, type Turn, withClientIndex } from "./index-map"

/**
 * One SDK agent loop in, **one** Anthropic message out.
 *
 * The SDK is an autonomous agent: it runs several internal turns, and each one emits a complete
 * Anthropic message sequence of its own — its own `message_start`, its own block numbering, its own
 * `message_delta` and `message_stop`. The client asked for a single completion and its parser
 * assumes exactly one. So this is a *funnel*, not a filter, and the three narrowings are the whole
 * module (docs/idea/11-anthropic-agent-sdk.md §6):
 *
 * - **Exactly one `message_start`**, from the first turn that produces one — or synthesized, if a
 *   turn produced content without one.
 * - **Intermediate `message_delta`s and `message_stop`s are dropped.** The SDK emits one pair per
 *   turn; a client that saw the first would stop reading and miss everything after the tool call.
 *   The last stop reason is remembered and stated once, at the end.
 * - **Exactly one `message_stop`**, after the loop, always terminal.
 *
 * **Nothing is ever fabricated.** A turn that produced no content ends as an empty completion with
 * whatever stop reason was actually reported — not a canned sentence, and not an invented
 * `end_turn` (§6: "A router must never fabricate model output"). A stop reason nobody stated is
 * `null`, which is what absence means everywhere else in this codebase.
 *
 * **Ids are constructed by us**, since none of the SDK's are the client's to see when a turn is
 * synthesized. `crypto.randomUUID` rather than a timestamp: Meridian's `msg_${Date.now()}` collides
 * under concurrency, which is the failure mode a shared router has and a single-user proxy does not.
 *
 * Frames come out as plain JSON objects rather than encoded SSE, because the same sequence has to
 * serve both response shapes — SSE for a streaming client, folded into one body for a
 * non-streaming one (`message.ts`). One state machine, two renderings, no chance of the two
 * disagreeing about where a block began.
 *
 * Pure apart from id generation. No clock, no I/O, and nothing here throws: once bytes are on the
 * wire a request fails honestly, and a malformed frame is worth dropping, never worth a crash.
 */

/** A client-visible Anthropic SSE frame. The object *is* the `data:` payload. */
export type ClientFrame = Readonly<Record<string, unknown>> & { readonly type: string }

const NO_FRAMES: readonly ClientFrame[] = []

export interface EnvelopeOptions {
  /** The model the client asked for — used only until the SDK names one, and if it never does. */
  readonly model: string
  /** Injected so a test can assert an exact id. Defaults to a CSPRNG-backed one. */
  readonly newId?: () => string
}

/** What the turn ended as, decided by the caller from the SDK's authoritative `result`. */
export interface Completion {
  /** Null when nothing stated one. Absence is reported as absence, never as `end_turn`. */
  readonly stopReason: string | null
  /** The authoritative counts. Null falls back to whatever the last `message_delta` stated. */
  readonly usage: SdkUsage | null
}

export interface Envelope {
  /** Whether a `message_start` has reached the client. */
  readonly started: boolean
  /** Whether the client has seen a terminal frame. Everything after one is dropped. */
  readonly terminated: boolean
  /** The message id the client was given, or null before `message_start`. */
  readonly id: string | null
  /**
   * A raw Anthropic wire event from a `stream_event` message.
   *
   * @param turn the message's `parent_tool_use_id`: null for the turn the client asked for, and a
   * subagent's id otherwise. A subagent's output never reaches the client — it is a conversation
   * nobody requested — but it is still routed through the index map, both so the whole
   * start/delta/stop triple is skipped together and so its own block numbering cannot collide with
   * the answer's.
   * @returns the client frames this event produced, in order. Never throws.
   */
  push(event: WireEvent, turn: Turn): readonly ClientFrame[]
  /** The SDK loop ended. @returns the terminal frames still owed. */
  finish(completion: Completion): readonly ClientFrame[]
  /** A classified failure. @returns one terminal `error` frame, after which nothing is emitted. */
  fail(type: string, message: string): readonly ClientFrame[]
}

export function createEnvelope(options: EnvelopeOptions): Envelope {
  const newId = options.newId ?? randomMessageId
  const blocks = createBlockIndexMap()

  let started = false
  let terminated = false
  let id: string | null = null
  let model = options.model
  let stopReason: string | null = null
  let stopSequence: string | null = null
  let lastUsage: SdkUsage | null = null

  const openStart = (out: ClientFrame[], event: WireEvent | null): void => {
    if (started) return
    started = true
    if (event === null) {
      id = newId()
      out.push(synthesizedStart(id, model))
      return
    }
    const facts = readMessageFacts(event.raw)
    id = facts.id ?? newId()
    model = facts.model ?? model
    out.push(normalizedStart(event.raw, id, model))
  }

  const push = (event: WireEvent, turn: Turn): readonly ClientFrame[] => {
    if (terminated) return NO_FRAMES
    const keep = turn === null
    const out: ClientFrame[] = []

    switch (event.type) {
      case "message_start":
        if (keep) openStart(out, event)
        break

      case "content_block_start": {
        if (event.index === null) break
        const decision = blocks.start(turn, event.index, keep)
        if (decision.kind === "drop") break
        // A block cannot precede the message that carries it, even when the SDK skipped the start.
        openStart(out, null)
        out.push(withClientIndex(event, decision.index))
        break
      }

      case "content_block_delta":
      case "content_block_stop": {
        if (event.index === null) break
        const decision =
          event.type === "content_block_stop"
            ? blocks.stop(turn, event.index)
            : blocks.block(turn, event.index)
        if (decision.kind === "forward") out.push(withClientIndex(event, decision.index))
        break
      }

      case "message_delta": {
        // Remembered, never forwarded: one turn's ending is not the response's.
        if (!keep) break
        const facts = readStopFacts(event.raw)
        if (facts.stopReason !== null) stopReason = facts.stopReason
        if (facts.stopSequence !== null) stopSequence = facts.stopSequence
        const usage = readUsage(event.raw.usage)
        if (usage !== null) lastUsage = usage
        break
      }

      // An upstream error, already spelled in the Anthropic dialect. Forwarded verbatim because the
      // provider's own answer is the honest one, and terminal because Anthropic's `error` is.
      case "error":
        if (keep) {
          terminated = true
          out.push({ ...event.raw, type: event.type })
        }
        break

      // `message_stop` and `ping` are the SDK's per-turn bookkeeping and our own pacing
      // respectively; both are emitted here rather than forwarded. An event type this build does
      // not define is dropped — the envelope cannot place a frame it cannot interpret, and §6
      // already records that unknown upstream features do not survive this path.
      default:
        break
    }

    return out
  }

  return {
    get started() {
      return started
    },
    get terminated() {
      return terminated
    },
    get id() {
      return id
    },
    push,

    finish(completion) {
      if (terminated) return NO_FRAMES
      terminated = true
      const out: ClientFrame[] = []
      openStart(out, null)
      for (const index of blocks.open()) out.push({ type: "content_block_stop", index })
      out.push({
        type: "message_delta",
        delta: { stop_reason: completion.stopReason ?? stopReason, stop_sequence: stopSequence },
        usage: outputCounts(completion.usage ?? lastUsage),
      })
      out.push({ type: "message_stop" })
      return out
    },

    fail(type, message) {
      if (terminated) return NO_FRAMES
      terminated = true
      return [{ type: "error", error: { type, message } }]
    },
  }
}

/**
 * `message_delta`'s usage block.
 *
 * `output_tokens` is required by the shape and is therefore the one count stated unconditionally.
 * Everything else appears only when the SDK actually counted it — the same rule
 * `services/translate/shared/usage.ts` applies at every other seam, for the same reason: a zero
 * written for a number nobody measured is invented data.
 */
function outputCounts(usage: SdkUsage | null): Record<string, number> {
  const counts: Record<string, number> = { output_tokens: usage?.output_tokens ?? 0 }
  if (usage === null) return counts
  if (usage.input_tokens !== null) counts.input_tokens = usage.input_tokens
  if (usage.cache_creation_input_tokens !== null) {
    counts.cache_creation_input_tokens = usage.cache_creation_input_tokens
  }
  if (usage.cache_read_input_tokens !== null) {
    counts.cache_read_input_tokens = usage.cache_read_input_tokens
  }
  return counts
}

/**
 * The SDK's `message_start`, with the id and model the client will be told about.
 *
 * A shallow rewrite of two fields rather than a rebuild: everything else the upstream stated —
 * `role`, `content`, `usage`, fields this build has never heard of — is the Anthropic dialect
 * already and is forwarded exactly as it arrived.
 */
function normalizedStart(
  raw: Readonly<Record<string, unknown>>,
  id: string,
  model: string,
): ClientFrame {
  const message = isRecord(raw.message) ? raw.message : {}
  return { ...raw, type: "message_start", message: { ...message, id, model } }
}

/**
 * The `message_start` for a turn that never sent one — a tool-only turn, a structured-output turn,
 * or an error close before the first content block.
 *
 * `content: []` is the point: an empty completion is the honest answer when the model produced
 * nothing, and the counts are stated in the terminal `message_delta` where the real ones live.
 */
function synthesizedStart(id: string, model: string): ClientFrame {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 122 bits from the platform CSPRNG. Unique across replicas, unlike anything clock-derived. */
function randomMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`
}
