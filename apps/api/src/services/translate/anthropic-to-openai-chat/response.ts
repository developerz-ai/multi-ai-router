import { z } from "zod"
import type { OpenAiChatToolCall } from "../shared/openai-chat"
import type { TranslatedResponse } from "../shared/response"
import { toOpenAiFinishReason } from "../shared/stop-reason"
import { parseAnthropicUsage, usageToOpenAiChat } from "../shared/usage"

/**
 * A non-streaming Anthropic `Message` → a `chat.completion` object.
 *
 * The mirror of `stream.ts` for the request that did not ask to stream, and it obeys the same two
 * rules the streaming half does. **Nothing here throws.** The upstream already answered — the
 * request succeeded, was billed, and cannot be retried onto another account — so a field this
 * module cannot read is reported as absent rather than turned into a failure the caller has no way
 * to act on (`docs/idea/06-protocol-translation.md`, "Rejected: nothing at stream time").
 *
 * openai-chat has no block concept, so the content array collapses: text blocks concatenate into
 * `message.content`, `tool_use` blocks become `tool_calls[]`, and `thinking` /`redacted_thinking`
 * are dropped as documented. A completion carrying only tool calls states `content: null`, which is
 * how OpenAI itself spells it — an empty string there reads as "the model said nothing out loud",
 * which is a different claim.
 */

const contentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().nullish().catch(null),
  id: z.string().nullish().catch(null),
  name: z.string().nullish().catch(null),
  input: z.unknown().optional(),
})

const messageSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  content: z.array(contentBlockSchema).nullish().catch(null),
  stop_reason: z.string().nullish().catch(null),
  usage: z.unknown().optional(),
})

export interface AnthropicToOpenAiChatResponseOptions {
  /** Unix **seconds**. A caller-supplied value, never `Date.now()`: a translator holds no clock. */
  readonly created: number
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function anthropicToOpenAiChatResponse(
  body: unknown,
  options: AnthropicToOpenAiChatResponseOptions,
): TranslatedResponse {
  const parsed = messageSchema.safeParse(body)
  const message = parsed.success ? parsed.data : null

  const texts: string[] = []
  const toolCalls: OpenAiChatToolCall[] = []
  for (const block of message?.content ?? []) {
    if (block.type === "text") {
      const text = block.text ?? ""
      if (text.length > 0) texts.push(text)
      continue
    }
    if (block.type !== "tool_use") continue
    toolCalls.push({
      id: block.id ?? "",
      type: "function",
      function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
    })
  }

  const stop = toOpenAiFinishReason(message?.stop_reason)
  const usage = parseAnthropicUsage(message?.usage)

  return {
    body: {
      // Ids pass through verbatim so one completion is traceable across the seam.
      id: message?.id ?? options.id ?? "",
      object: "chat.completion",
      created: options.created,
      model: message?.model ?? options.model ?? "",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: texts.length === 0 ? null : texts.join(""),
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          },
          finish_reason: stop.value,
        },
      ],
      // Omitted rather than zeroed when the upstream sent no usage block at all: a completion whose
      // cost nobody measured must not report as free.
      ...(usage === null ? {} : { usage: usageToOpenAiChat(usage) }),
    },
    unrecognizedStopReason: stop.unrecognized,
  }
}
