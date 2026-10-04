import type { DropSink } from "./drops"

/**
 * The reasoning dial across the Anthropic seam.
 *
 * OpenAI states it as `reasoning_effort` (chat) / `reasoning.effort` (responses); Anthropic states
 * it as `output_config.effort`. The two vocabularies overlap almost entirely — `low`, `medium`,
 * `high`, `xhigh`, `max` mean the same thing on both sides — so the word is **carried**, and moved
 * only where the target has no such word. That is a dial clamped to the nearest setting the target
 * understands, never a model substitution (non-negotiable 4).
 *
 * Pure: no clock, no store, no logger. A drop is reported through the caller's sink by field path,
 * never by value (`shared/drops.ts`).
 */

/** The words `output_config.effort` accepts. */
const ANTHROPIC_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"])

/** OpenAI words with no Anthropic spelling, and the nearest one. `none` is handled separately. */
const CLAMP_TO_ANTHROPIC: ReadonlyMap<string, string> = new Map([["minimal", "low"]])

const NO_ANTHROPIC_EFFORT =
  "names an effort anthropic does not state; dropped, so the upstream's default effort applies"

/**
 * Anthropic `thinking.budget_tokens` → an OpenAI effort bucket, used only when the client stated a
 * budget and no effort. These are protocol mappings (where a token budget sits on a word scale),
 * not limits or intervals: Claude Code's own presets — `think` 4 000, `megathink` 10 000,
 * `ultrathink` 31 999 — land on `low`, `medium`, `high` respectively.
 */
const BUDGET_LOW_UP_TO = 4_096
const BUDGET_MEDIUM_UP_TO = 16_384

export interface AnthropicReasoningFields {
  readonly output_config?: { readonly effort: string } | undefined
  readonly thinking?: { readonly type: "disabled" } | undefined
}

/**
 * An OpenAI effort word → the Anthropic fields that state it.
 *
 * `none` means "do not think", which Anthropic says with `thinking: {type: "disabled"}` rather than
 * an effort word. A word neither side's table knows is dropped and reported: Anthropic refuses an
 * effort it does not state, and failing the request over a dial would serve nothing.
 */
export function anthropicReasoningFromEffort(
  effort: string | null | undefined,
  field: string,
  onDrop: DropSink,
): AnthropicReasoningFields {
  if (effort === null || effort === undefined || effort.length === 0) return {}
  if (effort === "none") return { thinking: { type: "disabled" } }
  const word = CLAMP_TO_ANTHROPIC.get(effort) ?? effort
  if (ANTHROPIC_EFFORTS.has(word)) return { output_config: { effort: word } }
  onDrop({ field, reason: NO_ANTHROPIC_EFFORT })
  return {}
}

/** The two Anthropic request fields this module reads, as the request schema parses them. */
export interface AnthropicReasoningRequest {
  readonly thinking?: { readonly type: string; readonly budget_tokens?: number | undefined }
  readonly output_config?: { readonly effort?: string | undefined }
}

/**
 * Anthropic's reasoning fields → an OpenAI effort word, or `undefined` for the upstream default.
 *
 * An explicit `output_config.effort` wins and travels verbatim: every Anthropic word is also an
 * OpenAI one, and the OpenAI side never validates the word against a list of ours
 * (`06-protocol-translation.md`, the `reasoning_effort ⇄ reasoning.effort` row). Failing that, an
 * `enabled` thinking budget is bucketed. `adaptive` and `disabled` name no level and produce none —
 * `none` is not sent for `disabled`, because several OpenAI reasoning models refuse that word.
 */
export function openAiEffortFromAnthropic(request: AnthropicReasoningRequest): string | undefined {
  const stated = request.output_config?.effort
  if (stated !== undefined && stated.length > 0) return stated
  const thinking = request.thinking
  if (thinking?.type !== "enabled" || thinking.budget_tokens === undefined) return undefined
  if (thinking.budget_tokens <= BUDGET_LOW_UP_TO) return "low"
  if (thinking.budget_tokens <= BUDGET_MEDIUM_UP_TO) return "medium"
  return "high"
}

/**
 * Whether the client asked to see reasoning at all — thinking switched on, or an effort stated.
 * Toward Responses this is what asks the upstream for a reasoning summary to carry back.
 */
export function anthropicAskedForReasoning(request: AnthropicReasoningRequest): boolean {
  const type = request.thinking?.type
  if (type === "enabled" || type === "adaptive") return true
  return openAiEffortFromAnthropic(request) !== undefined
}
