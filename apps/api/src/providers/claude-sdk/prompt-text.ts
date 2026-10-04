/**
 * A content block with no user-message equivalent, rendered as one line of transcript text.
 *
 * Split from `prompt.ts`, which decides *which* messages are sent and in what frame; this decides
 * what a single block *says* once it can only be text. `nestedImages` is how many images
 * `prompt.ts` hoisted out of a `tool_result` to sibling blocks, so the line can name them.
 */

/**
 * A block with no user-message equivalent, rendered into the transcript.
 *
 * @returns null for a block that must not be replayed at all.
 */
export function renderBlock(
  block: Readonly<Record<string, unknown>>,
  nestedImages: number,
): string | null {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : null
    // Unsigned once replayed, and a model shown its own reasoning as text learns to write more of
    // it (§6). Absence is the honest rendering.
    case "thinking":
    case "redacted_thinking":
      return null
    case "tool_use":
      return renderToolUse(block)
    case "tool_result":
      return renderToolResult(block, nestedImages)
    // Only reached when `readImage` refused the source. Named rather than the generic label below,
    // so the model can tell the user *why* the image it was told about is not there.
    case "image":
      return `[image omitted: unsupported source type ${sourceTypeOf(block.source)}]`
    // Only valid inside a `system` message. Named as what happened: this transport registers tools
    // from `tools` alone, so an addition is news to the model, not a callable tool.
    case "tool_addition":
      return `[the client added the tool ${toolChangeName(block.tool)}]`
    case "tool_removal":
      return `[the client withdrew the tool ${toolChangeName(block.tool)}]`
    default:
      // Deliberately named rather than dropped: a client using a block type this build has never
      // seen is told the turn carried one, instead of silently losing it.
      return `[${String(block.type)} block]`
  }
}

function renderToolUse(block: Readonly<Record<string, unknown>>): string {
  const name = typeof block.name === "string" ? block.name : "a tool"
  return `[the assistant called ${name} with ${json(block.input)}]`
}

function renderToolResult(block: Readonly<Record<string, unknown>>, images: number): string {
  const failed = block.is_error === true ? " (it failed)" : ""
  return `[the client ran the requested tool${failed} and it returned: ${resultText(block.content, images)}]`
}

/**
 * A `tool_result`'s content is a string or blocks; its text goes into the transcript line, and its
 * images — hoisted to sibling blocks by `blocksOf` — are *named* here so an image-only result does
 * not read as a tool that returned nothing.
 */
function resultText(content: unknown, images: number): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return json(content)

  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue
    const value: unknown = Reflect.get(block, "text")
    if (typeof value === "string") parts.push(value)
  }

  const note =
    images === 0 ? null : `${images} image${images === 1 ? "" : "s"}, forwarded below this line`
  if (parts.length === 0) return note ?? "no textual output"
  return note === null ? parts.join("\n") : `${parts.join("\n")}\n(and ${note})`
}

/** A tool reference, an MCP reference, or an inline definition — each names its tool differently. */
function toolChangeName(tool: unknown): string {
  if (!isRecord(tool)) return "(unnamed)"
  if (typeof tool.name === "string") return tool.name
  if (isRecord(tool.definition) && typeof tool.definition.name === "string") {
    return tool.definition.name
  }
  return typeof tool.server_name === "string" ? `set from ${tool.server_name}` : "(unnamed)"
}

/**
 * What the omission line names as the reason. The media type when the source stated one — a
 * `base64` source only ever fails on it — otherwise the source type itself, which is the failing
 * field for every other shape. Never the data.
 */
function sourceTypeOf(source: unknown): string {
  if (!isRecord(source)) return "unknown"
  if (typeof source.media_type === "string") return source.media_type
  return typeof source.type === "string" ? source.type : "unknown"
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "nothing"
  } catch {
    return "arguments this router could not render"
  }
}
