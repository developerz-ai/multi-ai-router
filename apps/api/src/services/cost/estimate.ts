import type { ProviderId } from "@multi-ai-router/core"
import type { CostBasis } from "@multi-ai-router/db"
import type { TokenCounts } from "../usage"
import { lookupRates } from "./prices"

/**
 * What one attempt cost, or an honest admission that nobody knows.
 *
 * Pure arithmetic over the shipped price table: no clock, no store, no network, so it runs on the
 * request path beside the rest of the record assembly. Three outcomes, and the third is a feature:
 *
 * | Basis | When | Reported as |
 * |---|---|---|
 * | `metered` | A priced model on a pay-per-token account | Real spend |
 * | `notional` | A priced model on a **subscription** — a flat monthly fee has no per-request charge, so this is an attribution: "what this would have cost on the API" | A separate total, never summed with metered |
 * | `unknown` | No shipped rate for that provider + model | NULL, never zero |
 *
 * docs/idea/08-observability.md#cost-estimation.
 */

export interface CostEstimate {
  /** Dollars, as a decimal string at the column's scale. Null when no rate is known. */
  readonly costEstimate: string | null
  readonly costBasis: CostBasis
}

/** No rate, no number. `unknown` is a reported fact, not a default that stands in for one. */
export const UNKNOWN_COST: CostEstimate = { costEstimate: null, costBasis: "unknown" }

/** `cost_estimate` is `numeric(14, 6)`: six decimals, eight digits ahead of the point. */
const COST_SCALE = 6
const COST_CEILING = 100_000_000
const PER_MTOK = 1_000_000

/**
 * Providers whose accounts are a flat monthly fee rather than a per-token bill.
 *
 * Named per provider rather than derived from `authKind`: OAuth is an auth mechanism, and a metered
 * provider that authenticates with OAuth would be priced as an attribution by that shortcut.
 */
const SUBSCRIPTION_PROVIDERS: ReadonlySet<ProviderId> = new Set(["anthropic-oauth", "openai-oauth"])

/**
 * Price one attempt. `model` is the model that actually went **upstream** — after the account's
 * alias map — because that is the name the upstream billed.
 */
export function estimateCost(
  provider: ProviderId | null,
  model: string,
  tokens: TokenCounts,
): CostEstimate {
  if (provider === null) return UNKNOWN_COST
  const rates = lookupRates(provider, model)
  if (rates === null) return UNKNOWN_COST

  const dollars =
    (tokens.tokensIn * rates.inputPerMtok +
      tokens.tokensOut * rates.outputPerMtok +
      tokens.cacheReadTokens * rates.cacheReadPerMtok +
      tokens.cacheWriteTokens * rates.cacheWritePerMtok) /
    PER_MTOK

  // A count an upstream reported wrong can price past what the column holds. Unknown is both the
  // honest answer and the writable one: a value the column rejects fails the insert and takes every
  // other record batched with it down too.
  if (!Number.isFinite(dollars) || dollars < 0 || dollars >= COST_CEILING) return UNKNOWN_COST

  return {
    costEstimate: dollars.toFixed(COST_SCALE),
    costBasis: SUBSCRIPTION_PROVIDERS.has(provider) ? "notional" : "metered",
  }
}
