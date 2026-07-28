import type { ContextTable } from "@multi-ai-router/core"

/**
 * Anthropic context windows.
 *
 * Provenance: the published model reference, cross-checked against a live aggregator listing on the
 * date `CONTEXT_TABLE_AS_OF` names. Needed as a shipped table because Anthropic's own
 * `GET /v1/models` carries **no** size field at all — it answers `type`, `id`, `display_name` and
 * `created_at`, and nothing about how much fits.
 *
 * Blast radius of a stale row: the number rendered beside a model in the catalog listing, labelled
 * `shipped` so a reader can tell it from a live reading. Nothing in routing consults it, so a wrong
 * row misinforms; it never misroutes.
 */
export const ANTHROPIC_WINDOWS: ContextTable = {
  /** The 5 family: a million in, 128k out. */
  "claude-opus-5": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-5-fast": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-5": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-fable-5": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  /** The Glasswing twin of Fable 5, and sized identically. */
  "claude-mythos-5": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },

  "claude-opus-4-8": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-8-fast": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-7": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-7-fast": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-6": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-4-6": { contextTokens: 1_000_000, maxOutputTokens: 128_000 },

  /**
   * Where the 200k line still sits. Opus 4.5 and Haiku 4.5 were never widened, so a caller sizing a
   * prompt from "the Claude family is a million now" overruns them by five times — which is exactly
   * why these rows are stated rather than defaulted from the family above.
   */
  "claude-opus-4-5": { contextTokens: 200_000, maxOutputTokens: 64_000 },
  "claude-haiku-4-5": { contextTokens: 200_000, maxOutputTokens: 64_000 },
  "claude-opus-4-1": { contextTokens: 200_000, maxOutputTokens: 32_000 },
  "claude-opus-4": { contextTokens: 200_000, maxOutputTokens: 32_000 },
  "claude-3-haiku": { contextTokens: 200_000, maxOutputTokens: 4_096 },

  /** Sonnet 4 and 4.5 take the million-token window; their output ceiling stayed at 64k. */
  "claude-sonnet-4-5": { contextTokens: 1_000_000, maxOutputTokens: 64_000 },
  "claude-sonnet-4": { contextTokens: 1_000_000, maxOutputTokens: 64_000 },
}
