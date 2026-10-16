import { encodeSseEvent } from "../sse/emit"
import { createSseParser, type SseFrame } from "../sse/parse"

/**
 * A forced tool the vendor answered in text: the answer, put where the request said it would be.
 *
 * Third-party Anthropic-dialect vendors (MiniMax, measured 2026-10-15) treat `tool_choice` as a hint:
 * given a forced tool they answer `end_turn` with a text block holding the JSON the tool would have
 * carried, and no `tool_use`. The client asked for a tool call and cannot read the text as one —
 * `@ai-sdk/anthropic`'s `generateObject` reports "no content parts". The request is unambiguous
 * about what the tool call would have been, so the answer is moved into it.
 *
 * **Forced** means `tool_choice` `tool` naming X, or `any` with exactly one tool declared
 * ({@link forcedToolFromRequest}): with several tools `any` does not say which one the text is for.
 *
 * **Coerced only when it is unambiguous**: no `tool_use` block came back, and the text — trimmed,
 * optionally inside one fenced block — parses as a JSON object. The object is not validated against
 * the tool's schema (the client does that); an array, a scalar, prose, a truncated answer all pass
 * through unchanged. Nothing is ever fabricated: the `input` is the vendor's own bytes, re-read.
 * Other text is dropped, the `stop_reason` becomes `tool_use`, and the id is minted in Anthropic's
 * `toolu_` form from an injected source (this module holds no randomness).
 */

export type NewToolUseId = () => string

/** The tool a request forces, or `null` when it forces none or leaves the choice ambiguous. */
export function forcedToolFromRequest(body: unknown): string | null {
  if (!isObject(body)) return null
  const choice = body.tool_choice
  if (!isObject(choice)) return null
  if (choice.type === "tool") return typeof choice.name === "string" ? choice.name : null
  if (choice.type !== "any") return null
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length !== 1) return null
  const name = isObject(tools[0]) ? tools[0].name : undefined
  return typeof name === "string" && name.length > 0 ? name : null
}

const FENCE = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/i

/** The JSON object the text holds, or `null`. */
export function jsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const fenced = FENCE.exec(trimmed)
  const candidate = fenced?.[1] === undefined ? trimmed : fenced[1].trim()
  if (!candidate.startsWith("{")) return null
  try {
    const parsed: unknown = JSON.parse(candidate)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A whole Anthropic `Message`, coerced or `null` when it is to be left alone.
 */
export function coerceMessage(
  message: unknown,
  tool: string,
  newId: NewToolUseId,
): Record<string, unknown> | null {
  if (!isObject(message) || !Array.isArray(message.content)) return null
  if (message.stop_reason === "max_tokens") return null
  let text = ""
  for (const block of message.content) {
    if (!isObject(block)) return null
    if (block.type === "tool_use") return null
    if (block.type === "text" && typeof block.text === "string") text += block.text
  }
  const input = jsonObjectFromText(text)
  if (input === null) return null
  return {
    ...message,
    content: [{ type: "tool_use", id: newId(), name: tool, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
  }
}

/**
 * A whole Anthropic SSE stream, re-emitted as a valid sequence carrying the tool call, or `null`
 * when it is to be left alone (a `tool_use` block, an `error`, a non-object answer, or a stream
 * that never finished).
 *
 * The frames that survive are the upstream's own `message_start` and `message_delta` (usage intact,
 * `stop_reason` rewritten) and `message_stop`; the content blocks are replaced by one `tool_use`
 * block whose `input_json_delta` is the whole object.
 */
export function coerceStream(
  raw: Uint8Array,
  tool: string,
  newId: NewToolUseId,
): Uint8Array | null {
  const parser = createSseParser()
  const frames: SseFrame[] = [...parser.push(raw), ...parser.flush()]
  let start: Record<string, unknown> | null = null
  let delta: Record<string, unknown> | null = null
  let stopped = false
  let text = ""
  for (const frame of frames) {
    const payload = parse(frame.data)
    if (payload === null) continue
    const type = typeof payload.type === "string" ? payload.type : frame.event
    if (type === "error") return null
    if (type === "message_start") start = payload
    else if (type === "message_delta") delta = payload
    else if (type === "message_stop") stopped = true
    else if (type === "content_block_start") {
      const block = payload.content_block
      if (isObject(block) && block.type === "tool_use") return null
    } else if (type === "content_block_delta" && isObject(payload.delta)) {
      if (payload.delta.type === "text_delta" && typeof payload.delta.text === "string") {
        text += payload.delta.text
      }
    }
  }
  if (start === null || delta === null || !stopped) return null
  const inner = isObject(delta.delta) ? delta.delta : {}
  if (inner.stop_reason === "max_tokens") return null
  const input = jsonObjectFromText(text)
  if (input === null) return null

  const event = (type: string, body: Record<string, unknown>) =>
    encodeSseEvent({ event: type, data: JSON.stringify({ type, ...body }) })
  const out =
    event("message_start", withoutType(start)) +
    event("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: newId(), name: tool, input: {} },
    }) +
    event("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }) +
    event("content_block_stop", { index: 0 }) +
    event(
      "message_delta",
      withoutType({ ...delta, delta: { ...inner, stop_reason: "tool_use" } }),
    ) +
    event("message_stop", {})
  return new TextEncoder().encode(out)
}

function withoutType(payload: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, ...rest } = payload
  return rest
}

function parse(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
