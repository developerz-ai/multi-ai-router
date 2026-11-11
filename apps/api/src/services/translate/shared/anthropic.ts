import { z } from "zod"
import { cacheControlSchema } from "./cache-control-schema"

/**
 * The Anthropic Messages request, in the two shapes translation needs.
 *
 * `Parsed*` is what **arrives**: deliberately permissive, because a client may legitimately send a
 * block type or a tool form this build has never seen, and the translator has to drop it by name
 * rather than trip over it. The unsuffixed family is what a translator **emits** when
 * Anthropic is the target, and it is narrow — we only construct shapes we can stand behind.
 *
 * Nothing here runs on the passthrough path. Same-dialect egress keeps the body as opaque bytes,
 * and a full parse happens only when a cross-dialect conversion is genuinely required
 * (docs/idea/06-protocol-translation.md#performance-rules). Unknown top-level keys are stripped
 * rather than carried: a field this schema does not name has no counterpart in the target dialect,
 * and forwarding it would ship a body the upstream never agreed to.
 *
 * Two fields are named here purely so they can be **refused by name**: Anthropic's own
 * structured-output constraint. Stripped, it would be a contract lost without a word — the upstream
 * would answer in prose and the caller's `JSON.parse` would fail naming nothing
 * (`shared/reject.ts`).
 *
 * The schema is deliberately wider than what any translator carries. A block type it does not know
 * parses to {@link UNSUPPORTED_BLOCK} and is *dropped* by the translator with its type name reported
 * (`shared/drops.ts`), never refused: Claude Code sends `server_tool_use`, `web_search_tool_result`
 * and `document` blocks in an ordinary transcript, and a `400` over any of them served nothing. A
 * malformed *known* block is still a `400` — that body is not a valid Anthropic request.
 */

/** A block type this build cannot represent, kept as data so it can be refused by name. */
export const UNSUPPORTED_BLOCK = "__unsupported__"

/**
 * Anthropic requires `max_tokens`; every OpenAI dialect's ceiling is optional and most clients omit
 * it, so a value has to come from somewhere on the way in.
 *
 * A fact about this dialect rather than about one translator, which is why it lives beside the
 * schema that requires it: every `* → anthropic` request translator takes the operator's configured
 * value as a parameter and falls back to this only when a request reaches it without one. It is
 * deliberately generous — a low ceiling would truncate an answer the caller never asked to
 * truncate, the one failure a default must not cause silently.
 */
export const DEFAULT_MAX_TOKENS = 4096

const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "tool_addition",
  "tool_removal",
])

/**
 * A prompt-cache breakpoint. Read so a target that carries the marker — OpenRouter's
 * OpenAI-compatible surface, which maps it to each provider's own (`ProviderSurface.cacheControl`)
 * — gets it where the client put it; every other target never sees it.
 */
const cacheControl = cacheControlSchema

const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: cacheControl,
})

const imageSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
  z.object({ type: z.literal("url"), url: z.string() }),
  z.looseObject({ type: z.literal("file"), file_id: z.string().min(1) }),
])

const imageBlock = z.object({
  type: z.literal("image"),
  source: imageSource,
  cache_control: cacheControl,
})

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

/**
 * Inside a `tool_result`, the same rule as the top level: text and images are carried, and anything
 * else — a `document`, a `search_result`, a `tool_reference` from tool search — is reduced to its
 * type name so the translator can drop it by name rather than trip over it.
 */
const unsupportedToolResultContent = z
  .looseObject({ type: z.string() })
  .refine((block) => block.type !== "text" && block.type !== "image", {
    message: "malformed tool_result content block",
  })
  .transform((block) => ({ type: UNSUPPORTED_BLOCK, actual: block.type }) as const)

// Dispatched on `type` first, so a block pays for its own parser only, not every failing branch.
const toolResultContent = z.union([
  z.discriminatedUnion("type", [textBlock, imageBlock]),
  unsupportedToolResultContent,
])

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(toolResultContent)]).optional(),
  is_error: z.boolean().optional(),
  cache_control: cacheControl,
})

const thinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  // Read only to open a router seal (`sealed-reasoning.ts`); Anthropic's own are never parsed.
  signature: z.string().optional(),
})
const redactedThinkingBlock = z.object({ type: z.literal("redacted_thinking"), data: z.string() })

/** Beta, inside a mid-conversation `system` turn only. `tool` is read for its name and nothing else. */
const toolChangeBlock = z.object({
  type: z.enum(["tool_addition", "tool_removal"]),
  tool: z.unknown().optional(),
})

/**
 * A document: read for its `source`, whose `type` decides whether the target can carry it. A
 * `text` source is plain text and travels as such; every other source (a base64 PDF, a URL, a
 * Files-API id, nested content) is dropped by name with its media type — none of the OpenAI dialects
 * has a document part every compatible upstream accepts. Loose, because only `source.type`,
 * `media_type` and `data` are read.
 */
const documentBlock = z.object({
  type: z.literal("document"),
  source: z.looseObject({
    type: z.string(),
    media_type: z.string().optional(),
    data: z.string().optional(),
  }),
  cache_control: cacheControl,
})

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

/**
 * Dispatched on `type` before anything is parsed: a plain union ran (and failed) every earlier
 * branch for each block, ~4 ms of Zod for an 800-message transcript — the whole overhead budget.
 * A block of a known type that fails its own parser falls to `unsupportedBlock`, whose `refine`
 * refuses it, so the `400` still names the deepest field (`shared/reject.ts`, `locate`).
 */
export const anthropicBlockSchema = z.union([
  z.discriminatedUnion("type", [
    textBlock,
    imageBlock,
    toolUseBlock,
    toolResultBlock,
    thinkingBlock,
    redactedThinkingBlock,
    documentBlock,
    toolChangeBlock,
  ]),
  unsupportedBlock,
])

/** `system` is also a mid-conversation role; see `anthropic-system-turns.ts`. */
export const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(anthropicBlockSchema)]),
  /** `system` turns only. Any value but `"next_user_message"` is the default: always shown. */
  clear_at: z.unknown().optional(),
})

/** A server-side tool carries a `type` and no `input_schema`; `shared/tools.ts` refuses it by name. */
export const anthropicToolSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
})

const parallelToolPolicy = { disable_parallel_tool_use: z.boolean().optional() }

export const anthropicToolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto"), ...parallelToolPolicy }),
  z.object({ type: z.literal("any"), ...parallelToolPolicy }),
  z.object({ type: z.literal("none"), ...parallelToolPolicy }),
  z.object({ type: z.literal("tool"), name: z.string(), ...parallelToolPolicy }),
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
  // Read for the reasoning dial only (`reasoning-effort.ts`), and leniently: before these were
  // read they were stripped, so a shape this build does not expect falls back to absent rather than
  // turning a request that used to be served into a `400`.
  thinking: z
    .looseObject({ type: z.string(), budget_tokens: z.number().int().positive().optional() })
    .optional()
    .catch(undefined),
  output_config: z
    .looseObject({
      effort: z.string().optional().catch(undefined),
      // Anthropic's structured-output constraint, as the Messages API states it on the wire:
      // `output_config.format` — `{type: "json_schema", schema: {...}}`. Named here so it can be
      // refused by name instead of dropped with the rest of `output_config` (`shared/reject.ts`).
      format: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
  // The same constraint under the name Anthropic's own SDKs take it: `messages.parse(output_format=…)`,
  // which they send as `output_config.format`. A client stating it here states the same contract,
  // so it is refused the same way — and named as the caller wrote it.
  output_format: z.unknown().nullish(),
  // Automatic caching: one top-level marker the upstream moves forward as the conversation grows.
  cache_control: cacheControl,
})

export type ParsedAnthropicRequest = z.infer<typeof anthropicRequestSchema>
export type ParsedAnthropicMessage = z.infer<typeof anthropicMessageSchema>
export type ParsedAnthropicBlock = z.infer<typeof anthropicBlockSchema>
export type ParsedAnthropicImageSource = z.infer<typeof imageSource>
export type ParsedAnthropicToolResult = z.infer<typeof toolResultBlock>
export type ParsedAnthropicToolResultContent = z.infer<typeof toolResultContent>
export type ParsedAnthropicDocument = z.infer<typeof documentBlock>
export type ParsedAnthropicTool = z.infer<typeof anthropicToolSchema>
export type ParsedAnthropicCacheControl = z.infer<typeof cacheControl>
export type ParsedAnthropicToolChoice = z.infer<typeof anthropicToolChoiceSchema>

// What the `* → anthropic` translators emit lives apart from what they parse.
export type {
  AnthropicBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRedactedThinkingBlock,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./anthropic-emit"
