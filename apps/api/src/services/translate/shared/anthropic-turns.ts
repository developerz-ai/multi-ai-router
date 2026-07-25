import type { AnthropicBlock, AnthropicImageBlock, AnthropicMessage } from "./anthropic"
import { rejectField } from "./reject"

/**
 * Assembling an Anthropic transcript out of a flatter dialect's messages — the half of the work
 * every `* → anthropic` request translator does identically.
 *
 * **Anthropic requires strict `user`/`assistant` alternation and no OpenAI dialect does**, so this
 * is where the transcript is reshaped. Consecutive same-role turns are **merged, never reordered**
 * (docs/idea/06-protocol-translation.md#message-roles-and-content-blocks): merging concatenates
 * content the model was already going to read in that order, while reordering would change what it
 * was told. It lives here rather than in one translator because the rule is a fact about Anthropic,
 * and two copies of it could disagree about a transcript the model then reads differently depending
 * on which ingress dialect a client happened to use.
 */

export const BLOCK_JOIN = "\n\n"

/** `data:<media-type>;base64,<payload>` — the only inline image form any dialect here spells. */
const DATA_URI = /^data:([^;,]+);base64,([\s\S]*)$/

export interface AnthropicTurn {
  readonly role: "user" | "assistant"
  readonly blocks: AnthropicBlock[]
}

/** A turn that translated to nothing is dropped: Anthropic rejects an empty content array. */
export function pushTurn(
  turns: AnthropicTurn[],
  role: AnthropicTurn["role"],
  blocks: readonly AnthropicBlock[],
): void {
  if (blocks.length === 0) return
  turns.push({ role, blocks: [...blocks] })
}

export function mergeTurns(turns: readonly AnthropicTurn[]): AnthropicMessage[] {
  const merged: AnthropicTurn[] = []
  for (const turn of turns) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.role === turn.role) {
      previous.blocks.push(...turn.blocks)
      continue
    }
    merged.push(turn)
  }
  return merged.map((turn) => ({ role: turn.role, content: turn.blocks }))
}

/**
 * A remote URL is **not** fetched and inlined here.
 *
 * A translator is a pure function, and reaching out to an arbitrary URL from inside one would put a
 * network call — and an SSRF surface — on the request path. Anthropic's own `url` image source
 * carries the reference as-is, so the fetch never has to happen. Anything that is neither a `data:`
 * URI nor http(s) has no source form at all and is refused.
 *
 * @throws TranslationError (400) naming the field whose URL has no anthropic source form.
 */
export function imageBlockFromUrl(url: string, at: string): AnthropicImageBlock {
  const inline = DATA_URI.exec(url)
  const mediaType = inline?.[1]
  const data = inline?.[2]
  if (mediaType !== undefined && data !== undefined) {
    return { type: "image", source: { type: "base64", media_type: mediaType, data } }
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return { type: "image", source: { type: "url", url } }
  }
  rejectField(
    at,
    "is neither a base64 `data:` URI nor an http(s) URL, which are the only image sources anthropic accepts",
  )
}

/**
 * The plain text of a run of blocks, for the two places Anthropic holds text and nothing else: the
 * top-level system prompt, and a `tool_result`'s content.
 *
 * @param at the full path of the field the blocks came out of — `messages[0].content`,
 * `input[3].output`. Stated by the caller rather than having a suffix appended here, because the
 * source dialects disagree about what that field is called and a refusal must name one the client
 * can actually find in its own request.
 * @throws TranslationError (400) when a block has no text form, rather than dropping it — an image
 * a caller attached to a tool result is content, and losing it quietly answers a different question.
 */
export function blocksText(blocks: readonly AnthropicBlock[], at: string, purpose: string): string {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type !== "text") {
      rejectField(at, `carries a non-text part, which an anthropic ${purpose} cannot hold`)
    }
    texts.push(block.text)
  }
  return texts.join(BLOCK_JOIN)
}
