import { z } from "zod"

/**
 * The Anthropic Messages request, in the two shapes translation needs.
 *
 * `Parsed*` is what **arrives**: deliberately permissive, because a client may legitimately send a
 * block type or a tool form this build has never seen, and the translator has to name it in a
 * `400` rather than trip over it. The unsuffixed family is what a translator **emits** when
 * Anthropic is the target, and it is narrow — we only construct shapes we can stand behind.
 *
 * Nothing here runs on the passthrough path. Same-dialect egress keeps the body as opaque bytes,
 * and a full parse happens only when a cross-dialect conversion is genuinely required
 * (docs/idea/06-protocol-translation.md#performance-rules). Unknown top-level keys are stripped
 * rather than carried: a field this schema does not name has no counterpart in the target dialect,
 * and forwarding it would ship a body the upstream never agreed to.
 */

/** A block type this build cannot represent, kept as data so it can be refused by name. */
export const UNSUPPORTED_BLOCK = "__unsupported__"

const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
])

/** `cache_control` is stripped here: no non-Anthropic target has an equivalent hint. */
const textBlock = z.object({ type: z.literal("text"), text: z.string() })

const imageSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
  z.object({ type: z.literal("url"), url: z.string() }),
])

const imageBlock = z.object({ type: z.literal("image"), source: imageSource })

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

const toolResultContent = z.union([textBlock, imageBlock])

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(toolResultContent)]).optional(),
  is_error: z.boolean().optional(),
})

const thinkingBlock = z.object({ type: z.literal("thinking"), thinking: z.string() })
const redactedThinkingBlock = z.object({ type: z.literal("redacted_thinking"), data: z.string() })

/**
 * Everything else, reduced to its type name.
 *
 * The refusal is the translator's to make, not the schema's, because only the translator knows
 * which target it is aiming at. The `refine` keeps a *malformed* known block out of this branch —
 * otherwise a `tool_use` missing its `id` would be reported as an unsupported block type.
 */
const unsupportedBlock = z
  .looseObject({ type: z.string() })
  .refine((block) => !KNOWN_BLOCK_TYPES.has(block.type), { message: "malformed content block" })
  .transform((block) => ({ type: UNSUPPORTED_BLOCK, actual: block.type }) as const)

export const anthropicBlockSchema = z.union([
  textBlock,
  imageBlock,
  toolUseBlock,
  toolResultBlock,
  thinkingBlock,
  redactedThinkingBlock,
  unsupportedBlock,
])

export const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicBlockSchema)]),
})

/** A server-side tool carries a `type` and no `input_schema`; `shared/tools.ts` refuses it by name. */
export const anthropicToolSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
})

export const anthropicToolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }),
  z.object({ type: z.literal("any") }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("tool"), name: z.string() }),
])

export const anthropicRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessageSchema).min(1),
  max_tokens: z.number().int().positive(),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
})

export type ParsedAnthropicRequest = z.infer<typeof anthropicRequestSchema>
export type ParsedAnthropicMessage = z.infer<typeof anthropicMessageSchema>
export type ParsedAnthropicBlock = z.infer<typeof anthropicBlockSchema>
export type ParsedAnthropicImageSource = z.infer<typeof imageSource>
export type ParsedAnthropicToolResult = z.infer<typeof toolResultBlock>
export type ParsedAnthropicToolResultContent = z.infer<typeof toolResultContent>
export type ParsedAnthropicTool = z.infer<typeof anthropicToolSchema>
export type ParsedAnthropicToolChoice = z.infer<typeof anthropicToolChoiceSchema>

export interface AnthropicTextBlock {
  readonly type: "text"
  readonly text: string
}

export interface AnthropicImageBlock {
  readonly type: "image"
  readonly source: ParsedAnthropicImageSource
}

export interface AnthropicToolUseBlock {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/** Emitted with string content: the one form every `role:"tool"` message can be carried into. */
export interface AnthropicToolResultBlock {
  readonly type: "tool_result"
  readonly tool_use_id: string
  readonly content: string
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  readonly role: "user" | "assistant"
  readonly content: readonly AnthropicBlock[]
}

export interface AnthropicTool {
  readonly name: string
  readonly description?: string | undefined
  readonly input_schema: Record<string, unknown>
}

export type AnthropicToolChoice = ParsedAnthropicToolChoice

export interface AnthropicRequest {
  readonly model: string
  readonly messages: readonly AnthropicMessage[]
  readonly max_tokens: number
  readonly system?: string | undefined
  readonly temperature?: number | undefined
  readonly top_p?: number | undefined
  readonly stop_sequences?: readonly string[] | undefined
  readonly stream?: boolean | undefined
  readonly tools?: readonly AnthropicTool[] | undefined
  readonly tool_choice?: AnthropicToolChoice | undefined
}
