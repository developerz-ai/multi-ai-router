import type {
  ParsedAnthropicImageSource,
  ParsedAnthropicRequest,
  ParsedAnthropicToolResult,
  ParsedAnthropicToolResultContent,
} from "./anthropic"
import { BLOCK_JOIN } from "./anthropic-turns"
import { rejectField } from "./reject"

/**
 * Reading an Anthropic request — the half of the work every `anthropic → *` request translator does
 * identically, whichever OpenAI dialect it is aiming at.
 *
 * Each of the three moves here is a *narrowing*: Anthropic states a system prompt as a string or an
 * array of blocks and both OpenAI dialects hold one string; Anthropic states an image as a typed
 * source and OpenAI states a URL; Anthropic states a tool result as blocks with an `is_error` flag
 * and OpenAI states text. Where the narrowing loses a contract rather than a hint — an image inside
 * a tool result — it is refused by name, and the caller passes in what the target calls the thing
 * carrying it, so the message names a field the client can actually find.
 */

/**
 * `is_error` has no OpenAI field in either dialect. Folded into the text, because a failure that
 * reads as a success is worse than a clumsy prefix.
 */
const TOOL_ERROR_PREFIX = "Error: "

/** Multiple system blocks concatenate; the split cannot be reconstructed and is not claimed to be. */
export function systemText(system: ParsedAnthropicRequest["system"]): string {
  if (system === undefined) return ""
  if (typeof system === "string") return system
  return system
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join(BLOCK_JOIN)
}

export function imageUrlFromSource(source: ParsedAnthropicImageSource): string {
  return source.type === "url" ? source.url : `data:${source.media_type};base64,${source.data}`
}

/**
 * A `tool_result` block's content as text.
 *
 * @param carrier what the target dialect calls the message or item this text lands in, so a refusal
 * names something the caller can look up in their own dialect's documentation.
 * @throws TranslationError (400) when the result carries an image, which no OpenAI tool-result
 * carrier can hold.
 */
export function toolResultText(
  block: ParsedAnthropicToolResult,
  at: string,
  carrier: string,
): string {
  const content = block.content
  const text =
    content === undefined
      ? ""
      : typeof content === "string"
        ? content
        : joinToolResult(content, at, carrier)
  return block.is_error === true ? `${TOOL_ERROR_PREFIX}${text}` : text
}

function joinToolResult(
  blocks: readonly ParsedAnthropicToolResultContent[],
  at: string,
  carrier: string,
): string {
  const texts: string[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "text") {
      rejectField(
        `${at}.content[${index}].type`,
        `\`image\` cannot be carried in ${carrier}, which is text only`,
      )
    }
    texts.push(block.text)
  }
  return texts.join(BLOCK_JOIN)
}
