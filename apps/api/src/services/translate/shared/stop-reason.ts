/**
 * Why a completion ended, across every dialect seam.
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
 *
 * **openai-responses states the same fact in two fields** — a `status` plus an
 * `incomplete_details.reason` — so its conversions route through the openai-chat `finish_reason`
 * rather than restating the Anthropic table a second time. One table, read from both ends, cannot
 * drift out of agreement with itself, and the Responses column of the spec's table is exactly the
 * openai-chat column with the two fields split apart.
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

/**
 * An upstream's own `finish_reason` string, narrowed to the set this build defines.
 *
 * The openai-chat reading of what `toOpenAiFinishReason` does for Anthropic: a value outside the set
 * is a provider change, mapped conservatively and **returned** for the caller — which holds the
 * request id — to log. Absence is absence and reports nothing.
 */
export function readOpenAiFinishReason(
  reason: string | null | undefined,
): MappedReason<OpenAiFinishReason> {
  if (reason === null || reason === undefined) return ABSENT
  if (isOpenAiFinishReason(reason)) return { value: reason, unrecognized: null }
  return { value: CONSERVATIVE_FINISH_REASON, unrecognized: reason }
}

/** The pair of fields a Responses body states instead of one `finish_reason`. */
export interface ResponsesCompletion {
  readonly status: "completed" | "incomplete"
  /** `incomplete_details.reason`, or null when the response ran to its own end. */
  readonly incompleteReason: string | null
}

const MAX_OUTPUT_TOKENS = "max_output_tokens"
const CONTENT_FILTER = "content_filter"

/**
 * openai-chat `finish_reason` → a Responses `status` + `incomplete_details.reason`.
 *
 * `tool_calls` is **not** an incompleteness: a response that stopped to call a tool is `completed`
 * carrying a function-call output item, which is what the spec's table states and what a Responses
 * client branches on. An absent reason maps to `completed` — the conservative claim, and the only
 * one a body with no stated finish supports.
 */
export function toResponsesCompletion(
  reason: OpenAiFinishReason | null | undefined,
): ResponsesCompletion {
  if (reason === "length") return { status: "incomplete", incompleteReason: MAX_OUTPUT_TOKENS }
  if (reason === CONTENT_FILTER) return { status: "incomplete", incompleteReason: CONTENT_FILTER }
  return { status: "completed", incompleteReason: null }
}

/**
 * A Responses `status` + `incomplete_details.reason` → an openai-chat `finish_reason`.
 *
 * `hasToolCall` is the caller's, because only it has seen the output items: Responses says "the
 * model called a tool" by emitting a `function_call` item, never by naming a reason, so a
 * translation that ignored the items would report every tool call as ordinary text.
 *
 * A status that is neither `completed` nor `incomplete` — `in_progress`, `failed` — is **absence**,
 * not a finish: the upstream did not state that the completion ended well, and claiming `stop` for
 * it would report a success that did not happen.
 */
export function fromResponsesCompletion(
  status: string | null | undefined,
  incompleteReason: string | null | undefined,
  hasToolCall: boolean,
): MappedReason<OpenAiFinishReason> {
  if (status === "completed") {
    return { value: hasToolCall ? "tool_calls" : CONSERVATIVE_FINISH_REASON, unrecognized: null }
  }
  if (status !== "incomplete") return ABSENT
  if (incompleteReason === MAX_OUTPUT_TOKENS) return { value: "length", unrecognized: null }
  if (incompleteReason === CONTENT_FILTER) return { value: CONTENT_FILTER, unrecognized: null }
  // Incomplete for a reason this build does not define: a provider change, mapped conservatively
  // and reported, exactly as an unknown `stop_reason` is.
  return { value: CONSERVATIVE_FINISH_REASON, unrecognized: incompleteReason ?? "incomplete" }
}
