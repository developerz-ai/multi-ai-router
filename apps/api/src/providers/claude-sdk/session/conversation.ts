import { z } from "zod"

/**
 * The lineage view of an Anthropic Messages request: one normalized string per message, the first
 * user text, and whether the turn ends in a `tool_result`.
 *
 * It is a **separate, deliberately narrower read** than `services/translate`'s schema, for two
 * reasons. The translator's schema is a fidelity contract — it refuses a block it cannot represent,
 * because emitting a lossy body would be worse than a `400`. Lineage has the opposite obligation:
 * an unknown block must still hash, or a client using a brand-new content type would read as
 * diverged every turn and lose its warm session. It also cannot import that schema without
 * inverting the layer direction — `services/dataplane` imports `providers`, never the other way.
 *
 * **`cache_control` is stripped before hashing.** Clients move that marker around freely as their
 * own prompt cache slides; treating it as content is exactly the "harmless mutation reads as
 * divergence" failure the modified-continuation class exists to catch, and dropping it here means
 * most such requests never reach that slower path at all
 * (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * Keys are emitted in sorted order rather than as they arrived, so a client that reorders its JSON
 * between turns still hashes the same. The body is parsed here and only here on the SDK path — the
 * labeled exception to the passthrough rule, since the SDK is handed a prompt rather than bytes.
 */

/** Anthropic's own cap on the fingerprint seed (§4). Also bounds what a first message can cost. */
export const FIRST_USER_TEXT_LIMIT = 2000

export type LineageRole = "user" | "assistant"

export interface LineageMessage {
  readonly role: LineageRole
  /** `cache_control`-free, key-sorted rendering. The input to the lineage hash, never stored. */
  readonly normalized: string
}

export interface ConversationView {
  readonly messages: readonly LineageMessage[]
  /** Seeds the fingerprint. Empty when the conversation opens with something other than text. */
  readonly firstUserText: string
  /**
   * The turn's last block is a `tool_result` — a client running its own tool loop. Two concurrent
   * loops share a fingerprint, so a headerless request in this shape must never resume (§4).
   */
  readonly endsWithToolResult: boolean
}

const blockSchema = z.looseObject({ type: z.string() })

const messageSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(blockSchema)]),
})

/** Only `messages` is read. Everything else about the body belongs to some other module. */
const conversationSchema = z.looseObject({ messages: z.array(messageSchema) })

/**
 * @returns the view, or `null` when there is no body or it is not an Anthropic Messages request —
 * which is a "never resume" answer, not an error: nothing keyable arrived.
 */
export function readConversation(body: Uint8Array | null): ConversationView | null {
  if (body === null || body.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return null
  }

  const result = conversationSchema.safeParse(parsed)
  if (!result.success) return null

  const messages: LineageMessage[] = []
  let firstUserText = ""
  let endsWithToolResult = false

  for (const message of result.data.messages) {
    const role: LineageRole = message.role === "assistant" ? "assistant" : "user"
    // The separator is a NUL escape, never a literal byte in source: no role or rendered
    // block can contain one, so no message can spell another message's normalized form.
    messages.push({ role, normalized: `${role}\u0000${normalizeContent(message.content)}` })

    if (firstUserText === "" && role === "user") {
      firstUserText = leadingText(message.content).slice(0, FIRST_USER_TEXT_LIMIT)
    }
    endsWithToolResult = lastBlockIsToolResult(message.content)
  }

  return { messages, firstUserText, endsWithToolResult }
}

type Content = z.infer<typeof messageSchema>["content"]

function normalizeContent(content: Content): string {
  if (typeof content === "string") return content
  return content.map((block) => canonical(strip(block))).join("")
}

/** The opening text, for the fingerprint seed. A conversation that opens with an image seeds "". */
function leadingText(content: Content): string {
  if (typeof content === "string") return content
  for (const block of content) {
    const text = block.text
    if (block.type === "text" && typeof text === "string") return text
  }
  return ""
}

function lastBlockIsToolResult(content: Content): boolean {
  if (typeof content === "string") return false
  return content.at(-1)?.type === "tool_result"
}

/** Drops the one field clients mutate for reasons that have nothing to do with the conversation. */
function strip(block: Record<string, unknown>): Record<string, unknown> {
  if (!("cache_control" in block)) return block
  const { cache_control: _dropped, ...rest } = block
  return rest
}

/** Deterministic regardless of key order, so a re-serialized message hashes to the same string. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}
