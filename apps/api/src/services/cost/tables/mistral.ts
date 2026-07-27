import { type ModelTable, type RateCard, rates } from "../rates"

/**
 * Mistral's published per-Mtok API prices (USD list).
 *
 * Provenance: mistral.ai/pricing/api — the API table, not the consumer-plan anchor, whose FAQ still
 * quotes a superseded Large price. Verified on the date `PRICE_TABLE_AS_OF` names. Blast radius:
 * the metered total for `mistral` accounts.
 *
 * Mistral publishes no per-model cached-input line. It publishes one global rule instead — cached
 * input tokens are discounted 90% — so the read rate is **derived** from each model's input rate
 * rather than restated per row, the same way Anthropic's cache multiples are. A restated multiple
 * is a number that can drift from the one it was derived from.
 *
 * Not modelled: the batch discount (the router never batches) and the enterprise-API uplift, which
 * is a property of the operator's contract rather than of a model — an override is the fix.
 *
 * Rows are keyed by the `-latest` alias a client actually sends. Dated snapshots price through the
 * date-stripping fallback only where the vendor spells them `-YYYY-MM-DD`; Mistral's four-digit
 * `-2604` form is its own name, so a client pinning one prices as unknown rather than as a guess
 * that the pin still tracks the alias.
 */
function mistralRates(inputPerMtok: number, outputPerMtok: number): RateCard {
  return rates(inputPerMtok, outputPerMtok, { read: inputPerMtok * 0.1 })
}

export const MISTRAL_MODELS: ModelTable = {
  /** The flagship, despite the name: Medium 3.5 sits above Large 3 on this price list. */
  "mistral-medium-latest": mistralRates(1.5, 7.5),
  "mistral-large-latest": mistralRates(0.5, 1.5),
  "mistral-small-latest": mistralRates(0.15, 0.6),
  "ministral-3b-latest": mistralRates(0.1, 0.1),
  "ministral-8b-latest": mistralRates(0.15, 0.15),
  "ministral-14b-latest": mistralRates(0.2, 0.2),
  "codestral-latest": mistralRates(0.3, 0.9),
  "devstral-medium-latest": mistralRates(0.4, 2),
  "devstral-small-latest": mistralRates(0.1, 0.3),
  "magistral-medium-latest": mistralRates(2, 5),
  "magistral-small-latest": mistralRates(0.5, 1.5),
  "open-mixtral-8x22b": mistralRates(2, 6),
  "open-mixtral-8x7b": mistralRates(0.7, 0.7),
  "open-mistral-nemo": mistralRates(0.15, 0.15),
}
