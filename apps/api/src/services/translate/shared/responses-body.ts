import type { OpenAiResponsesUsage } from "./usage"

/**
 * The `response` object every `* → openai-responses` translator hands back, built once.
 *
 * A Responses body is not a completion with a `content` string: it is a `status`, an ordered
 * `output` array of *items*, and — when the model stopped early — an `incomplete_details.reason`.
 * The streaming half restates the same object twice (on `response.created`, and again on
 * `response.completed` with the output filled in), so the builder is shared with it rather than
 * written twice: a client that reads the final object and a client that reads the deltas must be
 * told the same thing (docs/idea/06-protocol-translation.md#streaming-sse-event-mapping).
 *
 * **Item ids are ours.** No source dialect names one — Anthropic numbers blocks, openai-chat has no
 * item concept at all — so they are derived from the response id and the item's position, which
 * keeps them deterministic and traceable rather than random. That block boundaries and their
 * identifiers are reconstructed rather than preserved is the documented loss of this seam.
 */

export interface ResponsesMessageItem {
  readonly type: "message"
  readonly id: string
  readonly text: string
}

export interface ResponsesFunctionCallItem {
  readonly type: "function_call"
  readonly id: string
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

/**
 * A reasoning *summary*, never the reasoning itself.
 *
 * Anthropic `thinking` text is the model's own scratchpad and Responses carries a summary of one;
 * the encrypted handle a native Responses upstream would also emit cannot be synthesized, and is
 * not.
 */
export interface ResponsesReasoningItem {
  readonly type: "reasoning"
  readonly id: string
  readonly summary: string
}

export type ResponsesOutputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesReasoningItem

export type ResponsesStatus = "in_progress" | "completed" | "incomplete" | "failed"

export interface ResponsesError {
  readonly code: string | null
  readonly message: string
}

export interface ResponsesBodyInput {
  readonly id: string
  readonly model: string
  /** Unix **seconds**, supplied by the caller: a translator holds no clock. */
  readonly created: number
  readonly status: ResponsesStatus
  /** `incomplete_details.reason`, or null when the response ran to its own end. */
  readonly incompleteReason: string | null
  readonly items: readonly ResponsesOutputItem[]
  readonly usage: OpenAiResponsesUsage | null
  readonly error?: ResponsesError | null | undefined
}

/** `annotations` is stated empty rather than omitted: the field is required by the part shape. */
export function responsesTextPart(text: string): Record<string, unknown> {
  return { type: "output_text", text, annotations: [] }
}

export function responsesItemJson(
  item: ResponsesOutputItem,
  status: "in_progress" | "completed",
): Record<string, unknown> {
  if (item.type === "message") {
    return {
      id: item.id,
      type: "message",
      status,
      role: "assistant",
      content: status === "in_progress" ? [] : [responsesTextPart(item.text)],
    }
  }
  if (item.type === "function_call") {
    return {
      id: item.id,
      type: "function_call",
      status,
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    }
  }
  return {
    id: item.id,
    type: "reasoning",
    summary: status === "in_progress" ? [] : [{ type: "summary_text", text: item.summary }],
  }
}

export interface ResponsesDoneEvent {
  readonly type: string
  readonly payload: Record<string, unknown>
}

/**
 * The `done` events a finished item owes before the next one opens, in order.
 *
 * They live here rather than in the emitter because each one restates a payload this module already
 * builds — the finished text as a content part, the summary as a summary part — and a `done` whose
 * shape disagreed with the object it mirrors would be worse than no `done` at all. `summary_index`
 * and `content_index` are always 0: this build opens one part per item, which is what makes the
 * boundaries reconstructible in the first place.
 */
export function responsesDoneEvents(
  item: ResponsesOutputItem,
  outputIndex: number,
): readonly ResponsesDoneEvent[] {
  const anchor = { item_id: item.id, output_index: outputIndex }
  if (item.type === "message") {
    return [
      {
        type: "response.output_text.done",
        payload: { ...anchor, content_index: 0, text: item.text },
      },
      {
        type: "response.content_part.done",
        payload: { ...anchor, content_index: 0, part: responsesTextPart(item.text) },
      },
    ]
  }
  if (item.type === "reasoning") {
    const part = { type: "summary_text", text: item.summary }
    return [
      {
        type: "response.reasoning_summary_text.done",
        payload: { ...anchor, summary_index: 0, text: item.summary },
      },
      {
        type: "response.reasoning_summary_part.done",
        payload: { ...anchor, summary_index: 0, part },
      },
    ]
  }
  return [
    {
      type: "response.function_call_arguments.done",
      payload: { ...anchor, arguments: item.arguments },
    },
  ]
}

export function responsesBodyJson(input: ResponsesBodyInput): Record<string, unknown> {
  const usage = responsesUsageJson(input.usage)
  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: input.status,
    model: input.model,
    output: input.items.map((item) => responsesItemJson(item, "completed")),
    incomplete_details: input.incompleteReason === null ? null : { reason: input.incompleteReason },
    error: input.error ?? null,
    // Omitted rather than zeroed when the upstream counted nothing: a response whose cost nobody
    // measured must not report as free (`06-protocol-translation.md#usage-and-token-fields`).
    ...(usage === undefined ? {} : { usage }),
  }
}

/** @returns undefined when the upstream stated no count at all — never a block of zeroes. */
export function responsesUsageJson(
  usage: OpenAiResponsesUsage | null,
): Record<string, unknown> | undefined {
  if (usage === null) return undefined
  const json: Record<string, unknown> = {}
  if (usage.input_tokens !== null) json.input_tokens = usage.input_tokens
  if (usage.output_tokens !== null) json.output_tokens = usage.output_tokens
  if (usage.total_tokens !== null) json.total_tokens = usage.total_tokens

  const cached = usage.input_tokens_details?.cached_tokens ?? null
  if (cached !== null) json.input_tokens_details = { cached_tokens: cached }
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? null
  if (reasoning !== null) json.output_tokens_details = { reasoning_tokens: reasoning }

  return Object.keys(json).length === 0 ? undefined : json
}

/** The id an item is given: deterministic, prefixed the way the native dialect prefixes its own. */
export function responsesItemId(
  kind: ResponsesOutputItem["type"],
  responseId: string,
  index: number,
): string {
  const prefix = kind === "message" ? "msg" : kind === "function_call" ? "fc" : "rs"
  return `${prefix}_${responseId}_${index}`
}
