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

/**
 * Mistral's reasoning models answer with `content` as an array of chunks, `{type:"text",text}` and
 * `{type:"thinking",thinking:[{type:"text",text}]}`, and the shape turns polymorphic mid-stream.
 * Read as a string it was absent, and the answer text went with it (developerz.ai plan 101 slice 09,
 * R11). Folded here, once, for every pair: text chunks become `content`; thinking chunks become the
 * reasoning text unless the upstream also named one, which wins (never doubled). Other chunk types
 * (references, images) state no text. A non-array `content` is untouched.
 */
function foldArrayContent(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn
  const content: unknown = Reflect.get(turn, "content")
  if (!Array.isArray(content)) return turn
  let text = ""
  let thinking = ""
  for (const chunk of content) {
    if (typeof chunk !== "object" || chunk === null) continue
    const type: unknown = Reflect.get(chunk, "type")
    if (type === "text") text += stringOf(Reflect.get(chunk, "text"))
    if (type === "thinking") thinking += thinkingText(Reflect.get(chunk, "thinking"))
  }
  const named = Reflect.get(turn, "reasoning_content") ?? Reflect.get(turn, "reasoning")
  return {
    ...turn,
    content: text.length === 0 ? null : text,
    ...(thinking.length > 0 && (typeof named !== "string" || named.length === 0)
      ? { reasoning_content: thinking }
      : {}),
  }
}

function thinkingText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  let text = ""
  for (const part of value) {
    if (typeof part === "object" && part !== null) text += stringOf(Reflect.get(part, "text"))
  }
  return text
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function turnSchema<T extends z.ZodType>(toolCall: T) {
  return z
    .preprocess(
      foldArrayContent,
      z.looseObject({
        content: z.string().nullish().catch(null),
        ...openAiChatReasoningSchema,
        tool_calls: z.array(toolCall).nullish().catch(null),
      }),
    )
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
