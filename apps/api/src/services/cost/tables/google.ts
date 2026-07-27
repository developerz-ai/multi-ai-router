import { type ModelTable, rates, tiered } from "../rates"

/**
 * Google's published per-Mtok Gemini prices, **paid tier, standard service tier**.
 *
 * Provenance: ai.google.dev/gemini-api/docs/pricing, verified on the date `PRICE_TABLE_AS_OF`
 * names. Blast radius: the metered total for `gemini` accounts.
 *
 * Two things the page prices that a `UsageRecord` cannot be charged for, and which are therefore
 * absent rather than folded into a rate:
 *
 * - **Context-cache storage**, billed per million tokens *per hour* ($1.00 for the Flash line,
 *   $4.50 for Pro). A duration nothing in a response reports, so charging it would be inventing
 *   how long the cache lived. The cache *read* price is here; the rent is not.
 * - **The audio input rate**, which several models price above their text rate. A response does not
 *   say which modality its input tokens were, so every row here is the text/image/video rate — an
 *   audio-heavy workload reads low, and an operator running one corrects it with an override.
 *
 * Only the Pro line is tiered; every Flash and Flash-Lite model is one price whatever the prompt.
 */

/** The prompt size at which Gemini's Pro line switches to its long-context rate. */
const LONG_CONTEXT_FROM = 200_000

export const GOOGLE_MODELS: ModelTable = {
  /** The only Pro model on the current list, and still Preview-status. */
  "gemini-3.1-pro-preview": tiered(
    rates(2, 12, { read: 0.2 }),
    LONG_CONTEXT_FROM,
    rates(4, 18, { read: 0.4 }),
  ),
  "gemini-2.5-pro": tiered(
    rates(1.25, 10, { read: 0.125 }),
    LONG_CONTEXT_FROM,
    rates(2.5, 15, { read: 0.25 }),
  ),

  /** Newest stable. */
  "gemini-3.6-flash": rates(1.5, 7.5, { read: 0.15 }),
  "gemini-3.5-flash": rates(1.5, 9, { read: 0.15 }),
  "gemini-3.5-flash-lite": rates(0.3, 2.5, { read: 0.03 }),
  "gemini-3.1-flash-lite": rates(0.25, 1.5, { read: 0.025 }),
  "gemini-3-flash-preview": rates(0.5, 3, { read: 0.05 }),
  "gemini-2.5-flash": rates(0.3, 2.5, { read: 0.03 }),
  "gemini-2.5-flash-lite": rates(0.1, 0.4, { read: 0.01 }),
}
