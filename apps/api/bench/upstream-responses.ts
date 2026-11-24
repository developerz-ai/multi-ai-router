/**
 * The stub upstream's Responses-API answers: what an `openai-responses` account sends back.
 *
 * Kept apart from `upstream.ts` because it is a third wire shape, not a variation of the other two,
 * and because it is the one prod spends the most translation time on: Claude Code posts Anthropic
 * Messages, a ChatGPT/Codex account answers in Responses events, and the router re-synthesises one
 * from the other chunk by chunk.
 */

const UPSTREAM_MODEL = "gpt-5"
const RESPONSE_ID = "resp_bench"
const ITEM_ID = "msg_bench"

interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
}

function usage(tokens: Usage): Record<string, unknown> {
  return {
    input_tokens: tokens.input_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: tokens.output_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: tokens.input_tokens + tokens.output_tokens,
  }
}

function message(text: string, status: "in_progress" | "completed"): Record<string, unknown> {
  return {
    id: ITEM_ID,
    type: "message",
    role: "assistant",
    status,
    content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
  }
}

function response(
  status: "in_progress" | "completed",
  text: string,
  tokens?: Usage,
): Record<string, unknown> {
  return {
    id: RESPONSE_ID,
    object: "response",
    created_at: 1_700_000_000,
    status,
    model: UPSTREAM_MODEL,
    output: status === "completed" ? [message(text, "completed")] : [],
    ...(tokens === undefined ? {} : { usage: usage(tokens) }),
  }
}

/** A non-streamed Responses answer. */
export function responsesBody(text: string, tokens: Usage): unknown {
  return response("completed", text, tokens)
}

function event(name: string, sequence: number, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, sequence_number: sequence, ...data })}\n\n`
}

/** A streamed Responses answer of `count` text deltas, opening and terminal events included. */
export function responsesStreamChunks(count: number, tokens: Usage): readonly string[] {
  const deltas = Array.from({ length: Math.max(1, count) }, (_unused, index) => `tok${index} `)
  const text = deltas.join("")
  let sequence = 0
  const next = () => sequence++

  const opening =
    event("response.created", next(), { response: response("in_progress", "") }) +
    event("response.output_item.added", next(), {
      output_index: 0,
      item: message("", "in_progress"),
    }) +
    event("response.content_part.added", next(), {
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })

  const body = deltas.map((delta) =>
    event("response.output_text.delta", next(), {
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      delta,
    }),
  )

  const closing =
    event("response.output_text.done", next(), {
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      text,
    }) +
    event("response.content_part.done", next(), {
      item_id: ITEM_ID,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    }) +
    event("response.output_item.done", next(), {
      output_index: 0,
      item: message(text, "completed"),
    }) +
    event("response.completed", next(), { response: response("completed", text, tokens) })

  // The first delta rides with the opening events, as the other dialects' first chunk does: the
  // trip's "first byte" is then a byte the client can be handed, not preamble it cannot see.
  const [first = "", ...rest] = body
  return [opening + first, ...rest, closing]
}
