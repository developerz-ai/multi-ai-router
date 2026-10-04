import { z } from "zod"
import { isRecord, renderBlock } from "./prompt-text"
import type { SdkRequestMessage } from "./request"
import type { SessionPlan } from "./session"

/**
 * The Anthropic Messages conversation, as the one user turn `query()` is given.
 *
 * The SDK owns the conversation; the Messages API does not. So a turn is either **rejoining** a
 * session the SDK already holds — in which case only what it has not seen is sent — or it is a
 * conversation the SDK has never had, which has to arrive as text
 * (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * Pure, and deliberately so: which of the two it is was already decided by `session/lineage.ts`
 * against stored hashes, and re-deriving it here would put one correctness decision in two places.
 * This module only renders the answer.
 *
 * | Plan | What is sent |
 * |---|---|
 * | `resume` / `fork` | `messages[deltaFrom..]` — the delta the session has not seen |
 * | `fresh` | every message, since the SDK holds nothing |
 *
 * **A replay is framed, and the framing is not decoration.** A flattened transcript handed to a
 * model reads as a *pattern*: it answers by continuing both speakers, and it learns to write tool
 * calls and their results as prose (§4, `messages.ts:97-113`). The frame says, in the prompt, that
 * the transcript is context rather than a form to imitate. It is only ever used where it is
 * unavoidable — one user turn with nothing before it is sent as itself, which is both the common
 * case and the honest one.
 *
 * **Structured content survives wherever it can.** Text and images pass through as real content
 * blocks, in place, including inside a replay; only blocks with no user-message equivalent —
 * `tool_use`, `tool_result`, a document, an unknown type — are rendered into the transcript as
 * text. Thinking is dropped rather than replayed: a thinking block re-sent as text is unsigned and
 * would teach the model to fabricate its own (§6, "thinking signatures").
 */

/** The opening of a replay. Written to be read by a model, not by an operator. */
const FRAME_OPEN =
  "<prior_conversation>\nThe turns below are a transcript of this conversation so far, replayed as text because the session that held them could not be resumed. Read it as context, not as a pattern to imitate: do not continue either speaker's turns, do not invent tool calls or tool results, and answer only the final user message that follows this transcript."

const FRAME_CLOSE = "</prior_conversation>"

/** What one message is labelled with inside a replay. */
const ROLE_LABEL: Record<SdkRequestMessage["role"], string> = {
  user: "user",
  assistant: "assistant",
  system: "system",
}

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const

/**
 * The image sources Anthropic defines and the SDK's own message shape accepts. A source that is
 * neither is not forwarded as an image — it is described in the transcript instead, because an
 * image block the SDK rejects fails the whole turn.
 */
const imageSourceSchema = z.union([
  z.object({
    type: z.literal("base64"),
    media_type: z.enum(IMAGE_MEDIA_TYPES),
    data: z.string(),
  }),
  z.object({ type: z.literal("url"), url: z.string() }),
])

export type PromptImageSource = z.infer<typeof imageSourceSchema>

/** One block of the user message handed to `query()`. Assignable to the SDK's own content shape. */
export type PromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: PromptImageSource }

export interface PromptInput {
  /** The conversation as the client sent it, in order. */
  readonly messages: readonly SdkRequestMessage[]
  /** Already resolved against this Account's own sessions. Applied verbatim. */
  readonly plan: SessionPlan
}

/**
 * @returns the content of the single user message this turn sends. Never empty: a turn with nothing
 * to say still has to say something, and an empty prompt is answered by an empty completion nobody
 * asked for.
 */
export function buildSdkPrompt(input: PromptInput): readonly PromptBlock[] {
  const send = messagesToSend(input).filter((message) => message.cleared !== true)
  if (send.length === 0) return [text("")]

  // Mid-conversation `system` messages travel with the turn they sit beside rather than counting
  // as turns of their own: a reminder after the live user message belongs to that live turn, and
  // one before the opening message does not make a first turn into a replay.
  const lastTurn = send.findLastIndex((message) => message.role !== "system")
  const last = send[lastTurn]

  // One user turn and nothing before it but instructions: the common case, sent unframed.
  if (last?.role === "user" && send.slice(0, lastTurn).every(isSystem)) return live(send)

  // A turn whose last message is the assistant's is a prefill, which `query()` has no target for.
  // It goes inside the transcript rather than being dropped: the client wrote it, and a model that
  // sees it framed will not mistake it for its own voice. With no turn at all, everything is framed.
  if (last?.role !== "user") return [text(FRAME_OPEN), ...transcript(send), text(FRAME_CLOSE)]

  const framed = send.slice(0, lastTurn)
  return [text(FRAME_OPEN), ...transcript(framed), text(FRAME_CLOSE), ...live(send.slice(lastTurn))]
}

function isSystem(message: SdkRequestMessage): boolean {
  return message.role === "system"
}

/**
 * The live turn: the user message with its instructions in client order. A lone user message is
 * sent as itself; a `system` message is marked as one, so its text is not read as the user's words.
 */
function live(messages: readonly SdkRequestMessage[]): readonly PromptBlock[] {
  return messages.flatMap((message) =>
    message.role === "system" ? [text("[system]"), ...blocksOf(message)] : blocksOf(message),
  )
}

/**
 * The slice this attempt owes the SDK.
 *
 * A resume that computes an empty delta still has to send something — a compaction whose recognized
 * suffix runs to the end of the incoming conversation is the shape that produces one — so the last
 * message is sent rather than nothing. Re-sending one message the session may already hold costs a
 * duplicated turn; sending nothing costs the answer.
 */
function messagesToSend(input: PromptInput): readonly SdkRequestMessage[] {
  const { messages, plan } = input
  if (plan.kind === "fresh") return messages

  const from = Math.min(Math.max(plan.deltaFrom, 0), messages.length)
  const delta = messages.slice(from)
  return delta.length > 0 ? delta : messages.slice(-1)
}

/** Every framed message, labelled by role, with its images left as images. */
function transcript(messages: readonly SdkRequestMessage[]): readonly PromptBlock[] {
  const out: PromptBlock[] = []
  for (const message of messages) {
    out.push(text(`[${ROLE_LABEL[message.role]}]`))
    out.push(...blocksOf(message))
  }
  return out
}

/**
 * One message's content as prompt blocks. Adjacent text is joined so a message that arrived as
 * fifteen text blocks does not become fifteen blocks in the prompt — the model reads the same
 * string either way, and the wire shape is ours to decide.
 */
function blocksOf(message: SdkRequestMessage | undefined): readonly PromptBlock[] {
  if (message === undefined) return []
  if (typeof message.content === "string") return [text(message.content)]

  const out: PromptBlock[] = []
  let pending: string[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    out.push(text(pending.join("\n")))
    pending = []
  }

  for (const block of message.content) {
    const image = readImage(block)
    if (image !== null) {
      flush()
      out.push(image)
      continue
    }
    const rendered = renderBlock(block, toolResultImages(block).length)
    if (rendered !== null) pending.push(rendered)
    // A `tool_result`'s nested images are hoisted to sibling top-level blocks, after the
    // transcript line that names them: the SDK's user message has no `tool_result` block to carry
    // them in place, and folding them into the bracketed text erased them entirely — a client
    // whose screenshot/PDF/chart tool returns an image lost it every turn (Meridian hoists the
    // same way). The transcript line above states how many follow, so the model can tie them back.
    for (const nested of toolResultImages(block)) {
      flush()
      out.push(nested)
    }
  }

  flush()
  // A message whose every block was dropped still occupied a turn; an empty text block keeps the
  // transcript's shape without claiming the client said something it did not.
  return out.length === 0 ? [text("")] : out
}

/** @returns the image block, or null when this is not one this transport can forward. */
function readImage(block: Readonly<Record<string, unknown>>): PromptBlock | null {
  if (block.type !== "image") return null
  const source = imageSourceSchema.safeParse(normalizeImageSource(block.source))
  return source.success ? { type: "image", source: source.data } : null
}

/**
 * `image/jpg` → `image/jpeg` before validation: a real-world misspelling (Meridian normalizes the
 * same one) that is unambiguous, and without this it demoted a perfectly forwardable image to an
 * omission line. Only that one exact value — anything else is genuinely not a type Anthropic
 * accepts, and inventing further mappings would forward images the API will reject.
 */
function normalizeImageSource(source: unknown): unknown {
  if (!isRecord(source) || source.media_type !== "image/jpg") return source
  return { ...source, media_type: "image/jpeg" }
}

/** Every nested image a `tool_result` carries, in order. Empty for every other block type. */
function toolResultImages(block: Readonly<Record<string, unknown>>): readonly PromptBlock[] {
  if (block.type !== "tool_result" || !Array.isArray(block.content)) return []
  const out: PromptBlock[] = []
  for (const nested of block.content) {
    if (!isRecord(nested)) continue
    const image = readImage(nested)
    if (image !== null) out.push(image)
  }
  return out
}

function text(value: string): PromptBlock {
  return { type: "text", text: value }
}
