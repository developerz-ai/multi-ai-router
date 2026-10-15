import { TranslationError } from "@multi-ai-router/core"

/**
 * A forced `tool_choice` on an anthropic passthrough to a vendor that thinks by default.
 *
 * Anthropic's dialect forbids a forced tool (`tool_choice` `any` or `tool`) beside extended thinking.
 * Real Anthropic is off unless asked, so a client that forces a tool and states no `thinking` is
 * sending a valid request; a compatible vendor that defaults thinking ON (MiniMax, measured
 * 2026-10-15) takes the same bytes, ignores the force, and answers `end_turn` in prose. The AI SDK's
 * `generateObject` is exactly that client: `tool_choice {type: "any"}`, no `thinking`.
 *
 * So for such a vendor the absent field is stated, the same call the translated path makes
 * (`openai-chat-to-anthropic/request.ts`). An explicit `enabled` / `adaptive` is a contradiction the
 * caller wrote, refused as Anthropic's own `invalid_request_error` rather than silently overridden:
 * the vendor would otherwise ignore the force and hand back prose.
 *
 * This is the one passthrough edit besides the model name that parses the body, and it parses only
 * when the bytes contain `tool_choice` at all, so an ordinary turn pays one substring scan.
 * Pure: no clock, no I/O. A body that is not a JSON object is returned untouched for the upstream
 * to judge.
 *
 * @throws TranslationError (400) when `thinking` is enabled beside a forced tool choice.
 */

const MARKER = new TextEncoder().encode('"tool_choice"')

const THINKING_WITH_FORCED_TOOL =
  "`thinking` is enabled while `tool_choice` forces tool use: thinking may not be enabled when tool_choice forces tool use; set `thinking.type` to `disabled` or use `tool_choice` `auto`"

export function disableThinkingForForcedTool(bytes: Uint8Array): Uint8Array {
  if (!contains(bytes, MARKER)) return bytes
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return bytes
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bytes
  const record = body as Record<string, unknown>
  if (!forces(record.tool_choice)) return bytes

  const thinking = record.thinking
  if (thinking === undefined || thinking === null) {
    return new TextEncoder().encode(JSON.stringify({ ...record, thinking: { type: "disabled" } }))
  }
  const type = (thinking as { type?: unknown }).type
  if (type === "enabled" || type === "adaptive")
    throw new TranslationError(THINKING_WITH_FORCED_TOOL)
  return bytes
}

function forces(choice: unknown): boolean {
  if (typeof choice !== "object" || choice === null) return false
  const type = (choice as { type?: unknown }).type
  return type === "any" || type === "tool"
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle)
}
