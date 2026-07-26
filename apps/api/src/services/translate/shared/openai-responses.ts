import { z } from "zod"

/**
 * The OpenAI Responses request, in the two shapes translation needs — the same split as
 * `shared/anthropic.ts` and `shared/openai-chat.ts`: `Parsed*` is what **arrives**, deliberately
 * permissive so an item type this build has never seen can be named in a `400`; the unsuffixed
 * family is what a translator **emits** when Responses is the target, and it is narrow.
 *
 * Responses is the **stateful** dialect, and that is why this file names fields it has no intention
 * of translating. `previous_response_id`, `store: true`, `include`, `conversation`, `prompt`,
 * `background: true`, and `reasoning` / `item_reference` items all mean "continue from, or leave
 * behind, something the server remembers", and the router remembers nothing: it picks an account per
 * request and holds no conversation state. They are declared here so `shared/reject.ts` can refuse
 * them **by name**
 * (docs/idea/06-protocol-translation.md#translation-matrix), which is the difference between a
 * client learning what to change and a client getting a silently truncated transcript.
 *
 * Nothing here runs on the passthrough path: a `openai-responses` client on a `openai-responses`
 * account is a byte relay and this module is never loaded for it.
 */

/** An item or content part this build cannot represent, kept as data so it is refused by name. */
export const UNSUPPORTED = "__unsupported__"

const KNOWN_PART_TYPES: ReadonlySet<string> = new Set([
  "input_text",
  "output_text",
  "input_image",
  "refusal",
])

const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
  "item_reference",
])

const inputTextPart = z.object({ type: z.literal("input_text"), text: z.string() })

/** What the model itself produced on an earlier turn, replayed by the client. Plain text. */
const outputTextPart = z.looseObject({ type: z.literal("output_text"), text: z.string() })

/** `detail` is stripped: no target dialect keeps a per-image resolution hint. */
const inputImagePart = z.looseObject({
  type: z.literal("input_image"),
  image_url: z.string().nullish(),
  file_id: z.string().nullish(),
})

/** A refusal the model produced earlier. Carried as text — the only form either target has. */
const refusalPart = z.looseObject({ type: z.literal("refusal"), refusal: z.string() })

const unsupportedPart = z
  .looseObject({ type: z.string() })
  .refine((part) => !KNOWN_PART_TYPES.has(part.type), { message: "malformed content part" })
  .transform((part) => ({ type: UNSUPPORTED, actual: part.type }) as const)

export const openAiResponsesPartSchema = z.union([
  inputTextPart,
  outputTextPart,
  inputImagePart,
  refusalPart,
  unsupportedPart,
])

const contentSchema = z.union([z.string(), z.array(openAiResponsesPartSchema)])

/** `type` is optional: `{role, content}` is the shorthand every Responses client writes. */
const messageItem = z.looseObject({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: contentSchema,
})

/** `arguments` is optional for the same reason it is on openai-chat: no-arg calls omit it. */
const functionCallItem = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string().optional(),
})

const functionCallOutputItem = z.looseObject({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: contentSchema.optional(),
})

/** Both are kept whole rather than reduced: they are refused, and a refusal names the item type. */
const reasoningItem = z.looseObject({ type: z.literal("reasoning") })
const itemReferenceItem = z.looseObject({ type: z.literal("item_reference") })

/**
 * Everything else, reduced to its type name — built-in tool calls (`web_search_call`,
 * `file_search_call`, `computer_call`) and whatever OpenAI adds after this was written. The refusal
 * belongs to the translator, which is the only thing that knows which target it is aiming at.
 */
const unsupportedItem = z
  .looseObject({ type: z.string() })
  .refine((item) => !KNOWN_ITEM_TYPES.has(item.type), { message: "malformed input item" })
  .transform((item) => ({ type: UNSUPPORTED, actual: item.type }) as const)

export const openAiResponsesItemSchema = z.union([
  functionCallItem,
  functionCallOutputItem,
  reasoningItem,
  itemReferenceItem,
  messageItem,
  unsupportedItem,
])

/**
 * A Responses tool is **flat** — `{type:"function", name, parameters}` — where a chat tool nests the
 * same fields under `function`. A built-in (`web_search_preview`, `file_search`, …) declares no
 * `parameters` at all and is refused by name in `shared/tools.ts`.
 */
export const openAiResponsesToolSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
})

export const openAiResponsesToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.looseObject({ type: z.string(), name: z.string().optional() }),
])

export const openAiResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(openAiResponsesItemSchema)]),
  instructions: z.string().nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  stream: z.boolean().nullish(),
  tools: z.array(openAiResponsesToolSchema).optional(),
  tool_choice: openAiResponsesToolChoiceSchema.optional(),
  reasoning: z.looseObject({ effort: z.string().nullish() }).nullish(),
  text: z.looseObject({ format: z.looseObject({ type: z.string() }).nullish() }).nullish(),
  // The six stateful fields. Declared only so they can be refused by name, and read loosely for the
  // same reason: a value this build never carries onto another dialect is not worth validating, and
  // a refusal naming the field beats a parse error naming a path inside it.
  previous_response_id: z.string().nullish(),
  store: z.boolean().nullish(),
  include: z.array(z.string()).nullish(),
  conversation: z.unknown().optional(),
  prompt: z.unknown().optional(),
  background: z.boolean().nullish(),
})

export type ParsedOpenAiResponsesRequest = z.infer<typeof openAiResponsesRequestSchema>
export type ParsedOpenAiResponsesItem = z.infer<typeof openAiResponsesItemSchema>
export type ParsedOpenAiResponsesContent = z.infer<typeof contentSchema>
export type ParsedOpenAiResponsesPart = z.infer<typeof openAiResponsesPartSchema>
export type ParsedOpenAiResponsesTool = z.infer<typeof openAiResponsesToolSchema>
export type ParsedOpenAiResponsesToolChoice = z.infer<typeof openAiResponsesToolChoiceSchema>

/** `input_text` on a user turn, `output_text` on an assistant one — Responses spells them apart. */
export interface OpenAiResponsesTextPart {
  readonly type: "input_text" | "output_text"
  readonly text: string
}

export interface OpenAiResponsesImagePart {
  readonly type: "input_image"
  readonly image_url: string
}

export type OpenAiResponsesPart = OpenAiResponsesTextPart | OpenAiResponsesImagePart

export type OpenAiResponsesRole = "user" | "assistant" | "system" | "developer"

export interface OpenAiResponsesMessageItem {
  readonly type: "message"
  readonly role: OpenAiResponsesRole
  readonly content: readonly OpenAiResponsesPart[]
}

export interface OpenAiResponsesFunctionCallItem {
  readonly type: "function_call"
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

export interface OpenAiResponsesFunctionCallOutputItem {
  readonly type: "function_call_output"
  readonly call_id: string
  readonly output: string
}

export type OpenAiResponsesItem =
  | OpenAiResponsesMessageItem
  | OpenAiResponsesFunctionCallItem
  | OpenAiResponsesFunctionCallOutputItem

export interface OpenAiResponsesTool {
  readonly type: "function"
  readonly name: string
  readonly description?: string | undefined
  readonly parameters: Record<string, unknown>
}

export type OpenAiResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { readonly type: "function"; readonly name: string }

export interface OpenAiResponsesRequest {
  readonly model: string
  readonly input: readonly OpenAiResponsesItem[]
  readonly instructions?: string | undefined
  readonly max_output_tokens?: number | undefined
  readonly temperature?: number | undefined
  readonly top_p?: number | undefined
  readonly stream?: boolean | undefined
  readonly tools?: readonly OpenAiResponsesTool[] | undefined
  readonly tool_choice?: OpenAiResponsesToolChoice | undefined
  readonly reasoning?: { readonly effort: string } | undefined
  /**
   * Always `false` on a translated request, never the caller's value.
   *
   * A stored response is server-side state keyed by an id, and the client that reaches this
   * translator asked in a dialect that has no way to name one on the next turn. Letting the default
   * stand would leave a transcript on the provider that nobody can reference or delete.
   */
  readonly store: false
}
