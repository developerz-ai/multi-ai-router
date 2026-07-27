import type { ProviderId } from "@multi-ai-router/core"

/**
 * The shape of a price and the two helpers every table under `tables/` is written with.
 *
 * Apart from the vendor tables themselves, this is the whole vocabulary of pricing: four numbers
 * per million tokens, optionally replaced wholesale above a prompt-size threshold. Kept here rather
 * than in `prices.ts` so a vendor table imports the shape without importing the assembled catalog,
 * and so the override book (`book.ts`) shares one definition with the shipped rows.
 */

/** The four numbers one request is priced against, per million tokens, in US dollars. */
export interface RateCard {
  readonly inputPerMtok: number
  readonly outputPerMtok: number
  readonly cacheReadPerMtok: number
  readonly cacheWritePerMtok: number
}

/**
 * A long-context tier: the rate that **replaces** the standard card once a request's prompt
 * reaches `fromPromptTokens`.
 *
 * Replaces, not tops up. Every vendor that publishes one of these — OpenAI above 272k, Google and
 * xAI above 200k — bills the *entire* request at the higher rate once the prompt crosses the line,
 * rather than charging the excess separately, and pricing it as a surcharge would understate a
 * long-context request by roughly half.
 */
export interface LongContextTier extends RateCard {
  readonly fromPromptTokens: number
}

export interface ModelRates extends RateCard {
  readonly longContext?: LongContextTier
}

/**
 * One row of the shipped table, flattened for display beside the operator's overrides.
 *
 * Flattened means one row **per tier**: a tiered model appears twice under the same name, the
 * second carrying the prompt size its card takes over at. The nested shape above is what pricing
 * reads; this is what a table renders.
 */
export type ShippedRate = {
  readonly provider: ProviderId
  readonly model: string
  /** Present only on a long-context row. Absent is the standard card, which starts at zero. */
  readonly fromPromptTokens?: number
} & RateCard

/**
 * How a caller asks for a price. The shipped `lookupRates` is one implementation and the warm
 * override-aware book is the other, which is the whole point: `estimateCost` prices an attempt
 * without knowing whether an operator has edited anything.
 */
export type RateLookup = (provider: ProviderId, model: string) => ModelRates | null

/**
 * One row, with the two cache numbers defaulted the way an absent published price means.
 *
 * - **No cached-input price published** → cached tokens bill at the ordinary input rate. That is
 *   what "the vendor states no discount" costs, and assuming a discount nobody published would
 *   under-report every cached request.
 * - **No cache-write price published** → zero. Every vendor here except Anthropic bills a cache
 *   *write* as ordinary input on the call that created it, so charging again for the write would
 *   double-count it. The counter behind it is Anthropic-only besides
 *   (`cache_creation_input_tokens`, `services/usage/tokens.ts`), so for an OpenAI-dialect upstream
 *   this multiplies zero tokens either way.
 *
 * Both defaults are stated rather than guessed per row, so a table that omits them says the same
 * thing everywhere.
 */
export function rates(
  inputPerMtok: number,
  outputPerMtok: number,
  cache: { readonly read?: number; readonly write?: number } = {},
): RateCard {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: cache.read ?? inputPerMtok,
    cacheWritePerMtok: cache.write ?? 0,
  }
}

/** A standard card plus the tier that replaces it above `fromPromptTokens`. */
export function tiered(standard: RateCard, fromPromptTokens: number, long: RateCard): ModelRates {
  return { ...standard, longContext: { fromPromptTokens, ...long } }
}

/**
 * A dated snapshot bills at its family's published rate, so `claude-haiku-4-5-20251001` prices as
 * `claude-haiku-4-5`. Stripping the date is not a guess — it is how the provider prices the pin.
 *
 * Both spellings, because the two vendors that pin dates spell them differently: Anthropic writes
 * `-20251001` and OpenAI writes `-2025-04-14`. A snapshot the vendor *does* price apart from its
 * family (`gpt-4o-2024-05-13`) is simply named in full in its table — the exact name is tried
 * first, so an explicit row always wins over the family it would otherwise fall back to.
 */
const SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/

/**
 * The names one model may be priced under, most specific first: the model as asked for, then its
 * family with the date pin stripped.
 *
 * Exported because the override book has to normalize a name exactly as the shipped table does — an
 * override written as `claude-haiku-4-5` must answer for `Claude-Haiku-4-5-20251001`. A second copy
 * of the rule is a second thing to keep in step with the first.
 */
export function modelLookupKeys(model: string): readonly [string, string] {
  const name = model.trim().toLowerCase()
  return [name, name.replace(SNAPSHOT_SUFFIX, "")]
}

/** A vendor table: normalized model name -> rates. */
export type ModelTable = Readonly<Record<string, ModelRates>>
