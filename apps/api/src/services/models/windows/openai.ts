import type { ContextTable } from "@multi-ai-router/core"

/**
 * OpenAI context windows.
 *
 * Provenance: the published model reference, cross-checked against a live aggregator listing on the
 * date `CONTEXT_TABLE_AS_OF` names. Shipped because OpenAI's `GET /v1/models` answers `id`,
 * `object`, `created` and `owned_by` and states no size — the same bare shape z.ai and MiniMax use.
 *
 * Blast radius of a stale row: a display number labelled `shipped`. Nothing in routing reads it.
 */
export const OPENAI_WINDOWS: ContextTable = {
  /** The 5.4+ generation, where the window widened past a million. */
  "gpt-5.6-terra": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.6-terra-pro": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.6-sol": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.6-sol-pro": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.6-luna": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.6-luna-pro": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.5": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.5-pro": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.4": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  "gpt-5.4-pro": { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
  /** The minis stayed at 400k while their full-size siblings widened. */
  "gpt-5.4-mini": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.4-nano": { contextTokens: 400_000, maxOutputTokens: 128_000 },

  /** The 400k tier — the whole 5.0-5.3 line, coding variants included. */
  "gpt-5.3-codex": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.2": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.2-codex": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.2-pro": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.1": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.1-codex": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.1-codex-max": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5.1-codex-mini": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5-codex": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5-pro": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5-mini": { contextTokens: 400_000, maxOutputTokens: 128_000 },
  "gpt-5-nano": { contextTokens: 400_000, maxOutputTokens: 128_000 },

  /**
   * The `-chat` variants are the trap in this table: they carry the generation's name and a
   * *quarter* of its window, so deriving a size from the family prefix overstates them fourfold.
   */
  "gpt-5.3-chat": { contextTokens: 128_000, maxOutputTokens: 16_384 },
  "gpt-5.2-chat": { contextTokens: 128_000, maxOutputTokens: 16_384 },
  "gpt-5.1-chat": { contextTokens: 128_000, maxOutputTokens: 32_000 },

  /** The reasoning line. */
  o3: { contextTokens: 200_000, maxOutputTokens: 100_000 },
  "o3-pro": { contextTokens: 200_000, maxOutputTokens: 100_000 },
  "o3-mini": { contextTokens: 200_000, maxOutputTokens: 100_000 },
  "o4-mini": { contextTokens: 200_000, maxOutputTokens: 100_000 },
  o1: { contextTokens: 200_000, maxOutputTokens: 100_000 },
  "o1-pro": { contextTokens: 200_000, maxOutputTokens: 100_000 },

  /** Still reachable, still asked for. */
  "gpt-4.1": { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  "gpt-4.1-mini": { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  "gpt-4.1-nano": { contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  "gpt-4o": { contextTokens: 128_000, maxOutputTokens: 16_384 },
  "gpt-4o-mini": { contextTokens: 128_000, maxOutputTokens: 16_384 },
  "gpt-4-turbo": { contextTokens: 128_000, maxOutputTokens: 4_096 },
}
