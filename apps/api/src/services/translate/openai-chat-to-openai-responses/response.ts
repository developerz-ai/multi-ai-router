import { z } from "zod"
import type { TranslatedResponse } from "../shared/response"
import type { ResponsesOutputItem } from "../shared/responses-body"
import { responsesBodyJson, responsesItemId } from "../shared/responses-body"
import { readOpenAiFinishReason, toResponsesCompletion } from "../shared/stop-reason"
import { openAiChatUsageToResponses, parseOpenAiChatUsage } from "../shared/usage"

/**
 * A non-streaming `chat.completion` object → an openai-responses `response` object.
 *
 * The mirror of `stream.ts` for the request that did not ask to stream, and — like it — this is the
 * direction that has to **invent structure**: openai-chat states one flat `content` string and a
 * separate `tool_calls[]`, while Responses states an ordered array of *items*, each with an id.
 * Text becomes one `message` item, then one `function_call` item per call, which is the order the
 * two arrived in on the wire. The item ids are ours, derived from the response id by
 * `shared/responses-body.ts`, because openai-chat names none.
 *
 * The finish reason splits in two here: Responses says "the model stopped early" with a `status`
 * plus an `incomplete_details.reason`, and `shared/stop-reason.ts` owns that table so the streaming
 * and non-streaming halves cannot disagree about it.
 *
 * **Nothing here throws.** The upstream already answered, so a malformed field is reported as absent
 * rather than turned into a failure on a request that cannot be retried
 * (`docs/idea/06-protocol-translation.md`, "Rejected: nothing at stream time"). That is the one
 * place this module differs from `request.ts`, where the same field is a `400` naming it: there,
 * nothing has happened yet and refusing costs the caller nothing.
 */

const toolCallSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  function: z
    .looseObject({
      name: z.string().nullish().catch(null),
      arguments: z.string().nullish().catch(null),
    })
    .nullish()
    .catch(null),
})

const completionSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nullish().catch(null),
        message: z
          .looseObject({
            content: z.string().nullish().catch(null),
            tool_calls: z.array(toolCallSchema).nullish().catch(null),
          })
          .nullish()
          .catch(null),
        finish_reason: z.string().nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null),
  usage: z.unknown().optional(),
})

export interface OpenAiChatToOpenAiResponsesResponseOptions {
  /** Unix **seconds**. A caller-supplied value, never `Date.now()`: a translator holds no clock. */
  readonly created: number
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function openAiChatToOpenAiResponsesResponse(
  body: unknown,
  options: OpenAiChatToOpenAiResponsesResponseOptions,
): TranslatedResponse {
  const parsed = completionSchema.safeParse(body)
  const completion = parsed.success ? parsed.data : null
  // Ids pass through verbatim so one response is traceable across the seam, and every item id is
  // derived from this one.
  const id = completion?.id ?? options.id ?? ""

  // `n > 1` is refused at request time, so the one choice a translated response can carry is the
  // first; an upstream that answered with more anyway has its extras dropped, never interleaved.
  const choice = (completion?.choices ?? []).find((entry) => (entry.index ?? 0) === 0)

  const items: ResponsesOutputItem[] = []
  const text = choice?.message?.content ?? ""
  // A completion that was only a tool call said nothing out loud, and an empty message item would
  // claim it answered with an empty string.
  if (text.length > 0) {
    items.push({ type: "message", id: responsesItemId("message", id, items.length), text })
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    items.push({
      type: "function_call",
      id: responsesItemId("function_call", id, items.length),
      call_id: call.id ?? "",
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "",
    })
  }

  const finish = readOpenAiFinishReason(choice?.finish_reason)
  const completed = toResponsesCompletion(finish.value)
  const usage = parseOpenAiChatUsage(completion?.usage)

  return {
    body: responsesBodyJson({
      id,
      model: completion?.model ?? options.model ?? "",
      created: options.created,
      status: completed.status,
      incompleteReason: completed.incompleteReason,
      items,
      // Null rather than a block of zeroes when the upstream counted nothing: a response whose cost
      // nobody measured must not report as free.
      usage: usage === null ? null : openAiChatUsageToResponses(usage),
    }),
    unrecognizedStopReason: finish.unrecognized,
  }
}
