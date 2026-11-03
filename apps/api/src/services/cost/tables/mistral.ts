import { type ModelTable, type RateCard, rates } from "../rates"

/**
 * Mistral's published per-Mtok API prices (USD list).
 *
 * Provenance: mistral.ai/pricing/api — the API table, not the consumer-plan anchor, whose FAQ still
 * quotes a superseded Large price — read 2026-11-03. Blast radius: the metered total for
 * `mistral` accounts.
 *
 * Mistral publishes a **cached-input price per model** on this page, so the read rate is stated per
 * row rather than derived from a global rule — a restated multiple is a number that can drift from
 * the one it was derived from, and the page states the figure itself.
 *
 * Not modelled: the batch discount (the router never batches), the priority tier, and the
 * enterprise-API uplift, which is a property of the operator's contract rather than of a model —
 * an override is the fix.
 *
 * Rows are keyed by the `-latest` alias a client actually sends. Dated snapshots price through the
 * date-stripping fallback only where the vendor spells them `-YYYY-MM-DD`; Mistral's four-digit
 * `-2604` form is its own name, so a client pinning one prices as unknown rather than as a guess
 * that the pin still tracks the alias.
 *
 * **Only models the price list publishes are here.** The Devstral, Magistral, Mixtral and Nemo
 * lines are absent: Mistral's current price table carries no row for them, and pricing a retired
 * id at its last known rate is a guess about a bill nobody is issuing.
 */
function mistralRates(
  inputPerMtok: number,
  outputPerMtok: number,
  cacheReadPerMtok: number,
): RateCard {
  return rates(inputPerMtok, outputPerMtok, { read: cacheReadPerMtok })
}

export const MISTRAL_MODELS: ModelTable = {
  /** Mistral Large 4 — $0.7 / $2.1, cached read $0.07. */
  "mistral-large-latest": mistralRates(0.7, 2.1, 0.07),
  /** Mistral Small 4 — $0.15 / $0.6, cached read $0.015. */
  "mistral-small-latest": mistralRates(0.15, 0.6, 0.015),
  /** Ministral 3 14B — $0.2 / $0.2, cached read $0.02. */
  "ministral-14b-latest": mistralRates(0.2, 0.2, 0.02),
  /** Ministral 3 8B — $0.15 / $0.15, cached read $0.015. */
  "ministral-8b-latest": mistralRates(0.15, 0.15, 0.015),
  /** Ministral 3 3B — $0.1 / $0.1, cached read $0.01. */
  "ministral-3b-latest": mistralRates(0.1, 0.1, 0.01),
  /** Codestral — $0.3 / $0.9, cached read $0.03. */
  "codestral-latest": mistralRates(0.3, 0.9, 0.03),
}
