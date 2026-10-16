/**
 * A forced `tool_choice` on an anthropic passthrough to a vendor that thinks by default.
 *
 * Anthropic's dialect forbids a forced tool (`tool_choice` `any` or `tool`) beside extended thinking.
 * Real Anthropic is off unless asked, so a client that forces a tool and states no `thinking` is
 * sending a valid request; a compatible vendor that defaults thinking ON (MiniMax, measured
 * 2026-10-15) takes the same bytes, ignores the force, and answers `end_turn` in prose. The AI SDK's
 * `generateObject` is exactly that client: `tool_choice {type: "any"}`, no `thinking`.
 *
 * So for such a vendor thinking is stated off beside the force — the same move the translated path
 * makes (`openai-chat-to-anthropic/request.ts`). An explicit `enabled` / `adaptive` is the same
 * contradiction one level up: the force is the caller's contract (the AI SDK will parse the tool
 * call), thinking is a dial, and the dial yields. It is rewritten to `disabled` rather than refused
 * — the router's job is to serve, and a `400` on a request the vendor can answer served nothing
 * (prod 2026-10-15..16, v2.37.3: 538 router-made `400`s on MiniMax-M3, every one the AI SDK's
 * forced `json` tool beside a thinking budget). A forced tool answered in prose is already caught
 * and coerced downstream (`dataplane/forced-tool-coercion.ts`). The model is never touched.
 *
 * This is the one passthrough edit besides the model name that parses the body, and it parses only
 * when the bytes contain `tool_choice` at all, so an ordinary turn pays one substring scan.
 * Pure: no clock, no I/O, no logger — the override is not reported, because the caller
 * (`chain-body.ts`) holds the only clean sink (`ctx.log`) and this function stays a pure body edit.
 * A body that is not a JSON object is returned untouched for the upstream to judge.
 */

const MARKER = new TextEncoder().encode('"tool_choice"')

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

  // Absent, `enabled` or `adaptive` thinking all yield to the force and are stated `disabled`; a
  // thinking the caller already set to `disabled` (or any other shape) is left as the client's bytes.
  const type = (record.thinking as { type?: unknown } | null | undefined)?.type
  if (
    record.thinking === undefined ||
    record.thinking === null ||
    type === "enabled" ||
    type === "adaptive"
  ) {
    return new TextEncoder().encode(JSON.stringify({ ...record, thinking: { type: "disabled" } }))
  }
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
