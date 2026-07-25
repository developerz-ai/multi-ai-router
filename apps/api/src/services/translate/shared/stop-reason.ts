/**
 * Why a completion ended, across the anthropic ⇄ openai-chat seam.
 *
 * The Anthropic set is **closed and complete** — `end_turn`, `max_tokens`, `stop_sequence`,
 * `tool_use`, `pause_turn`, `refusal` — and every member has a row in the table at
 * `docs/idea/06-protocol-translation.md#stop-and-finish-reasons`. A value outside the set is a
 * provider change, not a client error: it is mapped conservatively and **reported**, never dropped
 * silently and never passed through as a token the target dialect does not define.
 *
 * The reporting is a return value rather than a log line because a translator is a pure function
 * with no logger behind it (`06-protocol-translation.md#design-rules`). `unrecognized` is the
 * caller's cue to log — the caller is the one holding the request id.
 *
 * `null` in means the upstream has not finished yet: an openai-chat chunk carries
 * `finish_reason: null` on every delta before the last one. That is absence, not an unknown value,
 * and it maps to absence.
 */

export const ANTHROPIC_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
] as const

export type AnthropicStopReason = (typeof ANTHROPIC_STOP_REASONS)[number]

export const OPENAI_FINISH_REASONS = ["stop", "length", "tool_calls", "content_filter"] as const

export type OpenAiFinishReason = (typeof OPENAI_FINISH_REASONS)[number]

/**
 * A mapped reason plus the upstream value we did not recognize.
 *
 * `unrecognized` is non-null only when `value` is the conservative fallback, so a caller logs on
 * exactly the occasions worth logging: one line per provider change, none in steady state.
 */
export interface MappedReason<T> {
  readonly value: T | null
  readonly unrecognized: string | null
}

/** Both fallbacks say "the model stopped talking", the one claim that is safe to make blind. */
export const CONSERVATIVE_FINISH_REASON: OpenAiFinishReason = "stop"
export const CONSERVATIVE_STOP_REASON: AnthropicStopReason = "end_turn"

const ABSENT: MappedReason<never> = { value: null, unrecognized: null }

const TO_OPENAI: Record<AnthropicStopReason, OpenAiFinishReason> = {
  end_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  // Lossy: openai-chat has no field for *which* sequence matched. The Anthropic response carries it
  // in a separate top-level `stop_sequence`, which has nowhere to go here.
  stop_sequence: "stop",
  // Lossy: neither "the turn was paused mid-run" nor "the model declined" is expressible.
  pause_turn: "stop",
  refusal: "stop",
}

/**
 * A `Map`, not an object literal, because the key is an arbitrary upstream string: a plain object
 * would resolve `"toString"` and `"constructor"` through its prototype and hand a client a
 * `stop_reason` that is a function.
 */
const TO_ANTHROPIC: ReadonlyMap<string, AnthropicStopReason> = new Map([
  ["stop", "end_turn"],
  ["length", "max_tokens"],
  ["tool_calls", "tool_use"],
  // Lossy: Anthropic's `refusal` means the *model* declined, while `content_filter` means a
  // separate classifier intervened. Claiming the model refused would misattribute the decision, so
  // this maps to the neutral value and the reason is lost — as the spec's table says it is.
  ["content_filter", "end_turn"],
  // OpenAI's superseded single-function form. Deprecated, still emitted by several
  // OpenAI-compatible upstreams, and reaching the fallback would report a tool call as plain text.
  ["function_call", "tool_use"],
])

export function isAnthropicStopReason(value: string): value is AnthropicStopReason {
  return (ANTHROPIC_STOP_REASONS as readonly string[]).includes(value)
}

export function isOpenAiFinishReason(value: string): value is OpenAiFinishReason {
  return (OPENAI_FINISH_REASONS as readonly string[]).includes(value)
}

/** Anthropic `stop_reason` → openai-chat `finish_reason`. */
export function toOpenAiFinishReason(
  reason: string | null | undefined,
): MappedReason<OpenAiFinishReason> {
  if (reason === null || reason === undefined) return ABSENT
  if (isAnthropicStopReason(reason)) return { value: TO_OPENAI[reason], unrecognized: null }
  return { value: CONSERVATIVE_FINISH_REASON, unrecognized: reason }
}

/** openai-chat `finish_reason` → Anthropic `stop_reason`. */
export function toAnthropicStopReason(
  reason: string | null | undefined,
): MappedReason<AnthropicStopReason> {
  if (reason === null || reason === undefined) return ABSENT
  const mapped = TO_ANTHROPIC.get(reason)
  if (mapped !== undefined) return { value: mapped, unrecognized: null }
  return { value: CONSERVATIVE_STOP_REASON, unrecognized: reason }
}
