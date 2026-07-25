import { z } from "zod"
import type { AnthropicTextBlock, AnthropicToolUseBlock } from "../shared/anthropic"
import type { TranslatedResponse } from "../shared/response"
import { toAnthropicStopReason } from "../shared/stop-reason"
import { anthropicUsageCounts, parseOpenAiChatUsage } from "../shared/usage"

/**
 * A non-streaming `chat.completion` object → an Anthropic `Message`.
 *
 * The mirror of `stream.ts` for the request that did not ask to stream, and — like it — this is the
 * direction that has to **invent structure**: openai-chat states one flat `content` string and a
 * separate `tool_calls[]`, while Anthropic states an ordered array of blocks. Text is emitted
 * first, then one `tool_use` block per call, which is the order the two arrived in on the wire.
 *
 * **Nothing here throws.** The upstream already answered, so a malformed field is reported as
 * absent rather than turned into a failure on a request that cannot be retried
 * (`docs/idea/06-protocol-translation.md`, "Rejected: nothing at stream time"). That is the one
 * place this module differs from `request.ts`, where the same undecodable `arguments` string is a
 * `400` naming the call: there, nothing has happened yet and refusing costs the caller nothing.
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

export interface OpenAiChatToAnthropicResponseOptions {
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function openAiChatToAnthropicResponse(
  body: unknown,
  options: OpenAiChatToAnthropicResponseOptions = {},
): TranslatedResponse {
  const parsed = completionSchema.safeParse(body)
  const completion = parsed.success ? parsed.data : null

  // `n > 1` is refused at request time, so the one choice a translated response can carry is the
  // first; an upstream that answered with more anyway has its extras dropped, never interleaved.
  const choice = (completion?.choices ?? []).find((entry) => (entry.index ?? 0) === 0)

  const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = []
  const text = choice?.message?.content ?? ""
  // Anthropic rejects an empty text block, and a completion that was only a tool call said nothing.
  if (text.length > 0) content.push({ type: "text", text })
  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? "",
      name: call.function?.name ?? "",
      input: toolInput(call.function?.arguments),
    })
  }

  const stop = toAnthropicStopReason(choice?.finish_reason)

  return {
    body: {
      id: completion?.id ?? options.id ?? "",
      type: "message",
      role: "assistant",
      model: completion?.model ?? options.model ?? "",
      content,
      stop_reason: stop.value,
      // Lossy, and documented: openai-chat has no field naming *which* stop sequence matched.
      stop_sequence: null,
      usage: anthropicUsageCounts(parseOpenAiChatUsage(completion?.usage)),
    },
    unrecognizedStopReason: stop.unrecognized,
  }
}

/**
 * `arguments` (a JSON string) → `input` (an object), best effort.
 *
 * An upstream that streamed a call with undecodable arguments is broken, and there is no way to
 * say so in the shape — Anthropic's `input` has no array, scalar, or error form. An empty object
 * is the only representable answer; it is not a silent success, because the accompanying
 * `stop_reason: "tool_use"` still tells the client a call was made.
 */
function toolInput(raw: string | null | undefined): Record<string, unknown> {
  if (raw === null || raw === undefined || raw.trim().length === 0) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return {}
  return decoded as Record<string, unknown>
}
