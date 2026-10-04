import type { OpenAiChatPart } from "./openai-chat"
import type { ParsedOpenAiResponsesContent, ParsedOpenAiResponsesPart } from "./openai-responses"
import { rejectField } from "./reject"
export const PART_JOIN = "\n"
/**
 * A stored file is provider-side state one level below `previous_response_id`, and it is refused for
 * the same reason: the router resolves nothing against a provider it holds no session with.
 */
const STORED_FILE =
  "names a file stored inside openai-responses, which this router cannot resolve: it holds no provider-side state, and an openai-chat image part carries a URL and nothing else"

export function userParts(content: ParsedOpenAiResponsesContent, at: string): OpenAiChatPart[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }

  const parts: OpenAiChatPart[] = []
  for (const [index, part] of content.entries()) {
    const field = `${at}[${index}]`
    switch (part.type) {
      case "input_text":
      case "output_text":
        if (part.text.length > 0) parts.push({ type: "text", text: part.text })
        break
      case "refusal":
        // Carried as text: the model declined out loud on an earlier turn, and dropping the sentence
        // it declined with would replay the conversation as though it had said nothing.
        if (part.refusal.length > 0) parts.push({ type: "text", text: part.refusal })
        break
      case "input_image":
        parts.push({ type: "image_url", image_url: { url: imageUrl(part, field) } })
        break
      default:
        rejectField(`${field}.type`, `\`${part.actual}\` has no openai-chat counterpart`)
    }
  }
  return parts
}

/** The text of a content value, for the three carriers that hold text and nothing else. */
export function contentText(
  content: ParsedOpenAiResponsesContent | undefined,
  at: string,
  carrier: string,
): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content

  const texts: string[] = []
  for (const [index, part] of content.entries()) {
    texts.push(partText(part, `${at}[${index}]`, carrier))
  }
  return texts.join(PART_JOIN)
}

/**
 * @throws TranslationError (400) when the part has no text form, rather than dropping it — an image
 * the caller attached is content, and losing it quietly answers a different question.
 */
export function partText(part: ParsedOpenAiResponsesPart, at: string, carrier: string): string {
  if (part.type === "input_text" || part.type === "output_text") return part.text
  if (part.type === "refusal") return part.refusal
  if (part.type === "input_image") {
    rejectField(`${at}.type`, `\`input_image\` cannot be carried in ${carrier}, which is text only`)
  }
  rejectField(`${at}.type`, `\`${part.actual}\` has no openai-chat counterpart`)
}

/** @throws TranslationError (400) when the part names no URL an openai-chat image part can hold. */
export function imageUrl(
  part: { readonly image_url?: string | null; readonly file_id?: string | null },
  at: string,
): string {
  const url = part.image_url ?? ""
  if (url.length > 0) return url
  if ((part.file_id ?? "").length > 0) rejectField(`${at}.file_id`, STORED_FILE)
  rejectField(`${at}.image_url`, "is absent: an openai-chat image part is a URL")
}

/** A lone text part is emitted as a plain string — the shape every compatible upstream accepts. */
export function collapse(parts: readonly OpenAiChatPart[]): string | readonly OpenAiChatPart[] {
  if (parts.length === 0) return ""
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.type === "text") return only.text
  return parts
}
