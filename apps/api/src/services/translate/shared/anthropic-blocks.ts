import type {
  ParsedAnthropicDocument,
  ParsedAnthropicImageSource,
  ParsedAnthropicRequest,
  ParsedAnthropicToolResult,
} from "./anthropic"
import { BLOCK_JOIN } from "./anthropic-turns"
import type { DropSink } from "./drops"

/**
 * Reading an Anthropic request — the half of the work every `anthropic → *` request translator does
 * identically, whichever OpenAI dialect it is aiming at.
 *
 * Each of the moves here is a *narrowing*: Anthropic states a system prompt as a string or an array
 * of blocks and both OpenAI dialects hold one string; Anthropic states an image as a typed source
 * and OpenAI states a URL; Anthropic states a tool result as blocks with an `is_error` flag and
 * OpenAI states text. Where the narrowing loses content rather than a hint, the loss is either
 * *relocated* (an image inside a tool result) or *reported by name* through the drop sink
 * (`shared/drops.ts`) — never a `400`, and never silent.
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

/** What a `tool_result` becomes on the other side: text for the tool message, images hoisted out. */
export interface ToolResultParts {
  readonly text: string
  /** Images the carrier cannot hold, in order. The caller places them in the turn that follows. */
  readonly images: readonly ParsedAnthropicImageSource[]
}

/**
 * A `tool_result` block, split into what its target carrier can hold and what it cannot.
 *
 * No OpenAI tool-result carrier holds an image, and a coding agent's `Read` of a screenshot is
 * exactly a tool result carrying one. Refusing it was a `400` on a turn the agent could not rewrite;
 * dropping it would answer a question about an image the model never saw. So the image is
 * **hoisted**: returned separately, for the caller to place as user content directly after the tool
 * message — the same position a human pasting the screenshot would give it. Any other nested block
 * type is dropped and reported by name.
 *
 * @param at the block's path in the client's dialect, so a report names a field the caller can find.
 */
export function toolResultParts(
  block: ParsedAnthropicToolResult,
  at: string,
  onDrop: DropSink,
): ToolResultParts {
  const content = block.content
  const texts: string[] = []
  const images: ParsedAnthropicImageSource[] = []
  if (typeof content === "string") {
    texts.push(content)
  } else if (content !== undefined) {
    for (const [index, nested] of content.entries()) {
      if (nested.type === "text") texts.push(nested.text)
      else if (nested.type === "image") images.push(nested.source)
      else dropBlock(onDrop, `${at}.content[${index}]`, nested.actual, "a tool result")
    }
  }
  const text = texts.join(BLOCK_JOIN)
  return { text: block.is_error === true ? `${TOOL_ERROR_PREFIX}${text}` : text, images }
}

/**
 * A `document` block's text, or null when the target cannot read it.
 *
 * A `text` source *is* text and travels as such. A PDF, a URL, a Files-API id, or nested content has
 * no part every OpenAI-compatible upstream accepts, and is dropped with its media type reported —
 * the caller learns which attachment did not reach the model, instead of a `400` over a turn it
 * could not have rewritten.
 */
export function documentText(
  block: ParsedAnthropicDocument,
  at: string,
  onDrop: DropSink,
): string | null {
  const { source } = block
  if (source.type === "text" && typeof source.data === "string") return source.data
  const media = source.media_type === undefined ? "" : ` (\`${source.media_type}\`)`
  onDrop({
    field: at,
    reason: `is a \`document\` with a \`${source.type}\` source${media}, which no OpenAI dialect can carry; dropped`,
  })
  return null
}

/** One wording for every block type a target cannot represent, so a log line reads the same for all. */
export function dropBlock(onDrop: DropSink, at: string, actual: string, where: string): void {
  onDrop({ field: at, reason: `is a \`${actual}\` block, which ${where} cannot carry; dropped` })
}
