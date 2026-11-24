import type { SdkUsage, WireEvent } from "./events"
import type { ClientFrame } from "./frames"
import type { Turn } from "./index-map"

/** The envelope's contract, apart from the state machine that keeps it (`envelope.ts`). */

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
  /**
   * Blocks `finish` had to close because the upstream never did. Zero in every healthy turn — the
   * force-close below keeps the client's parser sound, but a non-zero count means an upstream (or
   * a filter of ours) dropped a `content_block_stop`, and without this counter that regression is
   * only visible in user transcripts, never in our logs (`stream.ts` reports it to the observer).
   */
  readonly forcedBlockCloses: number
  /**
   * What those blocks were — `text`, `tool_use`, `thinking`. Diagnostics only, and the one fact
   * that separates "the answer was cut short" from "the client was handed a tool call with no
   * arguments": nothing routes on it, and `sdk-attempt.ts` puts it on the alarm's log line.
   */
  readonly forcedBlockKinds: readonly string[]
}
