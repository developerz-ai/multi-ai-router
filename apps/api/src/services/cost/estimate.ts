import {
  type AccountBilling,
  DEFAULT_ACCOUNT_BILLING,
  type ProviderId,
} from "@multi-ai-router/core"
import type { CostBasis } from "@multi-ai-router/db"
import type { TokenCounts } from "../usage"
import { lookupRates } from "./prices"
import type { RateCard, RateLookup } from "./rates"

/**
 * What one attempt cost, or an honest admission that nobody knows.
 *
 * Pure arithmetic over an injected price lookup: no clock, no store, no network, so it runs on the
 * request path beside the rest of the record assembly. The lookup defaults to the table shipped with
 * the image; a deployment with operator overrides passes the warm book instead, and this function
 * never learns the difference. Three outcomes, and the third is a feature:
 *
 * | Basis | When | Reported as |
 * |---|---|---|
 * | `metered` | A priced model on a pay-per-token account | Real spend |
 * | `notional` | A priced model on a **subscription** account — a flat fee has no per-request charge, so this is an attribution: "what this would have cost on the API" | A separate total, never summed with metered |
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
 * Which basis a priced attempt is reported under, from the **Account's** billing mode.
 *
 * An account property, not a provider one. A hardcoded set of "subscription providers" was right
 * about the two providers sold only that way and wrong about every other: z.ai, Kimi and MiniMax
 * each sell a flat-fee coding plan behind the same endpoint and key shape as their metered API, and
 * nothing on the wire tells them apart. The operator records which they bought
 * (`AccountBilling`), and the two providers that are always a subscription say so through their
 * driver rather than through a list kept here — see `providers/types.ts`.
 */
const BASIS: Readonly<Record<AccountBilling, CostBasis>> = {
  metered: "metered",
  subscription: "notional",
}

export interface CostInput {
  readonly provider: ProviderId | null
  /**
   * The model that actually went **upstream** — after the account's alias map — because that is the
   * name the upstream billed.
   */
  readonly model: string
  readonly tokens: TokenCounts
  /** How the account is billed. Defaults to metered, the value an unstated account row holds. */
  readonly billing?: AccountBilling
  /**
   * The operator's price book, when one is wired. Absent prices off the table shipped in the image,
   * which is also what a router booted without a database-backed book must do.
   */
  readonly prices?: RateLookup
}

/** Price one attempt. */
export function estimateCost(input: CostInput): CostEstimate {
  const { provider, tokens } = input
  if (provider === null) return UNKNOWN_COST
  const rates = (input.prices ?? lookupRates)(provider, input.model)
  if (rates === null) return UNKNOWN_COST

  // The prompt is every input direction, cached or not: what a long-context tier is measured
  // against is how much context the request carried, not how much of it missed the cache.
  const promptTokens = tokens.tokensIn + tokens.cacheReadTokens + tokens.cacheWriteTokens
  const tier = rates.longContext
  const card: RateCard = tier !== undefined && promptTokens >= tier.fromPromptTokens ? tier : rates

  const dollars =
    (tokens.tokensIn * card.inputPerMtok +
      tokens.tokensOut * card.outputPerMtok +
      tokens.cacheReadTokens * card.cacheReadPerMtok +
      tokens.cacheWriteTokens * card.cacheWritePerMtok) /
    PER_MTOK

  // A count an upstream reported wrong can price past what the column holds. Unknown is both the
  // honest answer and the writable one: a value the column rejects fails the insert and takes every
  // other record batched with it down too.
  if (!Number.isFinite(dollars) || dollars < 0 || dollars >= COST_CEILING) return UNKNOWN_COST

  return {
    costEstimate: dollars.toFixed(COST_SCALE),
    costBasis: BASIS[input.billing ?? DEFAULT_ACCOUNT_BILLING],
  }
}
