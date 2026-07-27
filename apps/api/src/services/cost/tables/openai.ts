import { type ModelTable, rates, tiered } from "../rates"

/**
 * OpenAI's published per-Mtok prices, **standard service tier**.
 *
 * Provenance: platform.openai.com/docs/pricing, the "Standard" column, verified on the date
 * `PRICE_TABLE_AS_OF` names. Blast radius: the metered total for `openai-api` accounts and the
 * notional total for ChatGPT/Codex subscriptions, which are valued against this same table.
 *
 * Three deliberate omissions, each because the published number is not the one a `UsageRecord` can
 * be priced against:
 *
 * - **Batch and flex tiers** (50% off, and priced separately) — the router never sends a request to
 *   either, so the standard column is the one that describes what actually happened.
 * - **The regional-processing uplift** (+10% on data-residency endpoints for models released from
 *   2026-03-05) — a property of the account's endpoint rather than of the model. An operator on one
 *   of those endpoints corrects it with a price override, which is exactly what overrides are for.
 * - **Models the page prices as "—"** (`gpt-5.4-cyber`, and the deep-research / computer-use pair,
 *   whose standard-tier figures the page does not render) — absent here, so they price as unknown.
 *
 * Models with no published cached-input price do not offer prompt caching at all: the `pro` line,
 * `o1-pro`, `o3-pro`. `rates()` bills their cached tokens at the full input rate, which costs
 * nothing in practice because the count behind it is always zero.
 */

/** The prompt size at which the current flagship families switch to their long-context rate. */
const LONG_CONTEXT_FROM = 272_000

/**
 * GPT-5.6 Sol — the current default flagship, and the first family to publish a **cache write**
 * price of its own rather than folding writes into ordinary input. `gpt-5.6` is its alias.
 */
const GPT_5_6_SOL = tiered(
  rates(5, 30, { read: 0.5, write: 6.25 }),
  LONG_CONTEXT_FROM,
  rates(10, 45, { read: 1, write: 12.5 }),
)

/** The two `pro` models of the 5.4/5.5 generation, which share one price. */
const GPT_5_PRO_TIER = tiered(rates(30, 180), LONG_CONTEXT_FROM, rates(60, 270))

export const OPENAI_MODELS: ModelTable = {
  "gpt-5.6-sol": GPT_5_6_SOL,
  "gpt-5.6": GPT_5_6_SOL,
  "gpt-5.6-terra": tiered(
    rates(2.5, 15, { read: 0.25, write: 3.125 }),
    LONG_CONTEXT_FROM,
    rates(5, 22.5, { read: 0.5, write: 6.25 }),
  ),
  "gpt-5.6-luna": tiered(
    rates(1, 6, { read: 0.1, write: 1.25 }),
    LONG_CONTEXT_FROM,
    rates(2, 9, { read: 0.2, write: 2.5 }),
  ),

  "gpt-5.5": tiered(rates(5, 30, { read: 0.5 }), LONG_CONTEXT_FROM, rates(10, 45, { read: 1 })),
  "gpt-5.5-pro": GPT_5_PRO_TIER,
  "gpt-5.4": tiered(
    rates(2.5, 15, { read: 0.25 }),
    LONG_CONTEXT_FROM,
    rates(5, 22.5, { read: 0.5 }),
  ),
  "gpt-5.4-pro": GPT_5_PRO_TIER,
  /** The mini and nano tiers publish no long-context rate: one price, whatever the prompt. */
  "gpt-5.4-mini": rates(0.75, 4.5, { read: 0.075 }),
  "gpt-5.4-nano": rates(0.2, 1.25, { read: 0.02 }),
  /** The Codex specialization of 5.3, priced as its own line. */
  "gpt-5.3-codex": rates(1.75, 14, { read: 0.175 }),

  "gpt-5.2": rates(1.75, 14, { read: 0.175 }),
  "gpt-5.2-pro": rates(21, 168),
  "gpt-5.1": rates(1.25, 10, { read: 0.125 }),
  "gpt-5": rates(1.25, 10, { read: 0.125 }),
  "gpt-5-mini": rates(0.25, 2, { read: 0.025 }),
  "gpt-5-nano": rates(0.05, 0.4, { read: 0.005 }),
  "gpt-5-pro": rates(15, 120),
  /** The model behind ChatGPT itself, which the API prices as its own line. */
  "chat-latest": rates(5, 30, { read: 0.5 }),

  "gpt-4.1": rates(2, 8, { read: 0.5 }),
  "gpt-4.1-mini": rates(0.4, 1.6, { read: 0.1 }),
  "gpt-4.1-nano": rates(0.1, 0.4, { read: 0.025 }),
  "gpt-4o": rates(2.5, 10, { read: 1.25 }),
  /**
   * The one dated snapshot OpenAI prices apart from its family. Named in full because the
   * date-stripping fallback would otherwise price it at the current `gpt-4o` rate, half what it
   * bills; the exact name is tried first, so this row wins.
   */
  "gpt-4o-2024-05-13": rates(5, 15),
  "gpt-4o-mini": rates(0.15, 0.6, { read: 0.075 }),

  o3: rates(2, 8, { read: 0.5 }),
  "o3-pro": rates(20, 80),
  "o3-mini": rates(1.1, 4.4, { read: 0.55 }),
  "o4-mini": rates(1.1, 4.4, { read: 0.275 }),
  o1: rates(15, 60, { read: 7.5 }),
  "o1-pro": rates(150, 600),
  "o1-mini": rates(1.1, 4.4, { read: 0.55 }),
}
