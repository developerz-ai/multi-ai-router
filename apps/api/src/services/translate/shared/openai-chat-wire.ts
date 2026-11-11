import { z } from "zod"
import { openAiChatReasoningSchema } from "./openai-chat-reasoning"

/**
 * The openai-chat **upstream** wire both `openai-chat → X` pairs read: the streamed chunk and the
 * non-streamed completion. Forgiving by construction (`nullish().catch(null)`): the upstream already
 * answered, so a malformed field reads as absent rather than failing a request that cannot be
 * retried. One copy, so a fix to the reading lands in both pairs.
 */

/** A streamed call carries its `index`; the completion's calls are positional. */
const streamedToolCallSchema = z.looseObject({
  index: z.number().int().nonnegative().nullish().catch(null),
  id: z.string().nullish().catch(null),
  function: z
    .looseObject({
      name: z.string().nullish().catch(null),
      arguments: z.string().nullish().catch(null),
    })
    .nullish()
    .catch(null),
})

const toolCallSchema = streamedToolCallSchema.omit({ index: true })

function turnSchema<T extends z.ZodType>(toolCall: T) {
  return z
    .looseObject({
      content: z.string().nullish().catch(null),
      ...openAiChatReasoningSchema,
      tool_calls: z.array(toolCall).nullish().catch(null),
    })
    .nullish()
    .catch(null)
}

export const openAiChatChunkSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nullish().catch(null),
        delta: turnSchema(streamedToolCallSchema),
        finish_reason: z.string().nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null),
  usage: z.unknown().optional(),
})

export const openAiChatCompletionSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nullish().catch(null),
        message: turnSchema(toolCallSchema),
        finish_reason: z.string().nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null),
  usage: z.unknown().optional(),
})
