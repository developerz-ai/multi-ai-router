import { forcesOpenAiChatTool } from "./tool-choice"

/**
 * The vendor `enable_thinking` dial, for OpenAI-compatible endpoints that reason **by default** and
 * reject a forced `tool_choice` while they do.
 *
 * Qwen's "3.8" hybrid series (`qwen3.8-max`, `qwen3.8-flash`) think unless told not to, and their
 * OpenAI-compatible endpoint answers `400` "The tool_choice parameter does not support being set to
 * required or object in thinking mode" to a forced tool — so dropping a *client-sent* thinking is
 * not enough (`reasoning-effort.ts`): the model still reasons with no field present. The dial is
 * `enable_thinking`, a plain top-level body field DashScope reads on the wire (`extra_body` in the
 * OpenAI SDKs). It is **not** OpenAI-standard, so a vanilla OpenAI / Codex endpoint `400`s on it —
 * it is emitted **only** for a matched upstream model, **only** for openai-chat egress, and **only**
 * beside a forced tool. It is a vendor dial, never a model change (non-negotiable 4). Research:
 * `docs/research/thinking-and-tool-choice.md`.
 *
 * Which models think by default drifts and pooling means many accounts of one provider, so the set
 * is **config** (`OPENAI_CHAT_THINKING_DEFAULT_MODELS`), never a constant (non-negotiable 11). The
 * matcher is a pure function of that injected snapshot.
 */

/** Matches an upstream (post-alias) model id against the configured think-by-default set. */
export type ThinkingDefaultMatcher = (upstreamModelId: string) => boolean

/**
 * A pure matcher over a configured list of exact model ids and `prefix*` globs (the only glob form:
 * a trailing `*`, matched as a prefix). Whitespace-only entries are ignored, and an empty list
 * matches nothing — the default, so the dial is never emitted until an operator names a model.
 */
export function createThinkingDefaultMatcher(patterns: readonly string[]): ThinkingDefaultMatcher {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const pattern of patterns) {
    const trimmed = pattern.trim()
    if (trimmed.length === 0) continue
    if (trimmed.endsWith("*")) prefixes.push(trimmed.slice(0, -1))
    else exact.add(trimmed)
  }
  if (exact.size === 0 && prefixes.length === 0) return () => false
  return (id) => exact.has(id) || prefixes.some((prefix) => id.startsWith(prefix))
}

/**
 * Add `enable_thinking: false` to a **translated** openai-chat body when its `tool_choice` forces a
 * tool and the upstream model is one the matcher knows to think by default. Otherwise the body is
 * returned unchanged. Pure: the matcher is injected, no clock, no I/O.
 *
 * Applied at the point the per-attempt model is reapplied (`dataplane/translate-body.ts`), because
 * the match is against the account's upstream model — the alias the operator bills — not the name
 * the client sent.
 */
export function disableThinkingDefaultForForcedTool(
  body: Record<string, unknown>,
  upstreamModelId: string,
  matches: ThinkingDefaultMatcher,
): Record<string, unknown> {
  if (!matches(upstreamModelId)) return body
  if (!forcesOpenAiChatTool(body.tool_choice)) return body
  return { ...body, enable_thinking: false }
}
