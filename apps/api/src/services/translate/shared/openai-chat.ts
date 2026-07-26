import { DEFAULT_OPENAI_CHAT_CEILING, type OpenAiChatCeiling } from "@multi-ai-router/core"
import { z } from "zod"

/**
 * The OpenAI Chat Completions request, in the two shapes translation needs — same split as
 * `shared/anthropic.ts`: `Parsed*` is what arrives, the unsuffixed family is what we emit.
 *
 * Four fields are declared here purely so they can be **refused by name** (`n`, `logprobs`,
 * `top_logprobs`, `response_format`); `shared/reject.ts` owns that call. The documented hints — `seed`,
 * `frequency_penalty`, `presence_penalty`, `logit_bias`, `user`, `parallel_tool_calls` — are
 * deliberately absent instead, because "not in the schema" is exactly what dropping them means
 * (docs/idea/06-protocol-translation.md#known-lossy-edges).
 */

/** A content part this build cannot represent, kept as data so it can be refused by name. */
export const UNSUPPORTED_PART = "__unsupported__"

const KNOWN_PART_TYPES: ReadonlySet<string> = new Set(["text", "image_url"])

const textPart = z.object({ type: z.literal("text"), text: z.string() })

/** `detail: "low" | "high"` is stripped: Anthropic has no per-image resolution hint. */
const imagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.looseObject({ url: z.string() }),
})

/** Audio and file parts land here, and so does anything OpenAI adds after this was written. */
const unsupportedPart = z
  .looseObject({ type: z.string() })
  .refine((part) => !KNOWN_PART_TYPES.has(part.type), { message: "malformed content part" })
  .transform((part) => ({ type: UNSUPPORTED_PART, actual: part.type }) as const)

export const openAiChatPartSchema = z.union([textPart, imagePart, unsupportedPart])

const contentSchema = z.union([z.string(), z.array(openAiChatPartSchema)])

/** `arguments` is optional because several OpenAI-compatible upstreams omit it on no-arg calls. */
const toolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string().optional() }),
})

export const openAiChatMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: contentSchema }),
  z.object({ role: z.literal("developer"), content: contentSchema }),
  z.object({ role: z.literal("user"), content: contentSchema }),
  z.object({
    role: z.literal("assistant"),
    content: contentSchema.nullish(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    content: contentSchema.optional(),
  }),
])

/** `strict` is stripped; a tool with no `function` is refused by name in `shared/tools.ts`. */
export const openAiChatToolSchema = z.looseObject({
  type: z.string().optional(),
  function: z
    .looseObject({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})

export const openAiChatToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({ type: z.literal("function"), function: z.looseObject({ name: z.string() }) }),
])

export const openAiChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(openAiChatMessageSchema).min(1),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  stream: z.boolean().nullish(),
  tools: z.array(openAiChatToolSchema).optional(),
  tool_choice: openAiChatToolChoiceSchema.optional(),
  n: z.number().int().nullish(),
  logprobs: z.boolean().nullish(),
  top_logprobs: z.number().int().nullish(),
  // Structured output, declared only so it can be refused by name. Loose because the refusal reads
  // `type` and nothing else — a schema this build never carries is not worth validating.
  response_format: z.looseObject({ type: z.string() }).nullish(),
})

export type ParsedOpenAiChatRequest = z.infer<typeof openAiChatRequestSchema>
export type ParsedOpenAiChatMessage = z.infer<typeof openAiChatMessageSchema>
export type ParsedOpenAiChatContent = z.infer<typeof contentSchema>
export type ParsedOpenAiChatToolCall = z.infer<typeof toolCallSchema>
export type ParsedOpenAiChatTool = z.infer<typeof openAiChatToolSchema>
export type ParsedOpenAiChatToolChoice = z.infer<typeof openAiChatToolChoiceSchema>

export interface OpenAiChatTextPart {
  readonly type: "text"
  readonly text: string
}

export interface OpenAiChatImagePart {
  readonly type: "image_url"
  readonly image_url: { readonly url: string }
}

export type OpenAiChatPart = OpenAiChatTextPart | OpenAiChatImagePart

export interface OpenAiChatToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export type OpenAiChatRole = "system" | "user" | "assistant" | "tool"

export interface OpenAiChatMessage {
  readonly role: OpenAiChatRole
  readonly content?: string | readonly OpenAiChatPart[] | undefined
  readonly tool_calls?: readonly OpenAiChatToolCall[] | undefined
  readonly tool_call_id?: string | undefined
}

export interface OpenAiChatTool {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters: Record<string, unknown>
  }
}

export type OpenAiChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } }

export interface OpenAiChatRequest {
  readonly model: string
  readonly messages: readonly OpenAiChatMessage[]
  /** Never emitted beside `max_completion_tokens`: see {@link chatCeiling}. */
  readonly max_tokens?: number | undefined
  readonly max_completion_tokens?: number | undefined
  readonly temperature?: number | undefined
  readonly top_p?: number | undefined
  readonly stop?: readonly string[] | undefined
  readonly stream?: boolean | undefined
  readonly stream_options?: { readonly include_usage: true } | undefined
  readonly tools?: readonly OpenAiChatTool[] | undefined
  readonly tool_choice?: OpenAiChatToolChoice | undefined
}

/**
 * The output ceiling under the one name this target accepts, as an object to spread into an emitted
 * body.
 *
 * **Exactly one of the two names is ever present, and emitting both is not the safe middle.** OpenAI
 * refuses `max_tokens` on a reasoning model whether or not the new name sits beside it, so a body
 * carrying both fails on precisely the models the new name exists for. Which one an upstream takes
 * is its driver's answer, defaulted here to the name every compatible vendor states — a translator
 * handed no answer still emits a ceiling rather than dropping the one the caller set.
 */
export function chatCeiling(
  value: number | undefined,
  ceiling: OpenAiChatCeiling = DEFAULT_OPENAI_CHAT_CEILING,
): Pick<OpenAiChatRequest, "max_tokens" | "max_completion_tokens"> {
  return ceiling === "max_completion_tokens"
    ? { max_completion_tokens: value }
    : { max_tokens: value }
}
