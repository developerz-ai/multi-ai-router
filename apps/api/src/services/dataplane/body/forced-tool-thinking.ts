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
const DISABLED = new TextEncoder().encode('"disabled"')

/**
 * A model that runs only with thinking on (`ProviderSurface.thinkingRequiredModels`, MiniMax-M3.1-
 * Flash, prod 2026-11-05: `400` 2013 on every `thinking.type="disabled"`). For it the dial yields the
 * other way: a stated `disabled`, whether the client's own or the translator's (a forced tool, a
 * structured output, `reasoning_effort: none`), becomes `adaptive` at the **lowest** effort — the
 * nearest thing to "off" the model takes — unless the body already states an effort the vendor
 * names, which is the client's and is kept. Through 2.51.0 `disabled` was only removed, which left
 * the vendor's own default effort (`max` on MiniMax) on every forced-tool call.
 *
 * Provenance: driven live through OpenCode Go's anthropic surface 2026-11-06 — `adaptive` + `low`,
 * bare `low`, bare `max` and no thinking at all each answer `200` with the forced tool; `disabled`
 * answers `400` 2013. The forced `tool_choice` is kept: the vendor takes it beside thinking and, when
 * it answers in prose instead, `forced-tool-coercion.ts` moves the text into the tool call. Parses
 * only when the bytes contain `"disabled"`; anything else is returned as the same bytes.
 */
const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"])
const LOWEST_EFFORT = "low"

export function keepThinkingForRequiredModel(bytes: Uint8Array): Uint8Array {
  if (!contains(bytes, DISABLED)) return bytes
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return bytes
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bytes
  const record = body as Record<string, unknown>
  if ((record.thinking as { type?: unknown } | null | undefined)?.type !== "disabled") return bytes
  const config =
    typeof record.output_config === "object" &&
    record.output_config !== null &&
    !Array.isArray(record.output_config)
      ? (record.output_config as Record<string, unknown>)
      : {}
  const stated = typeof config.effort === "string" && EFFORTS.has(config.effort)
  return new TextEncoder().encode(
    JSON.stringify({
      ...record,
      thinking: { type: "adaptive" },
      output_config: { ...config, effort: stated ? config.effort : LOWEST_EFFORT },
    }),
  )
}

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
