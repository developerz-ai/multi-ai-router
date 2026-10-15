import { type ModelTable, rates } from "../rates"

/**
 * z.ai's published per-Mtok GLM prices, international platform.
 *
 * Provenance: docs.z.ai/guides/overview/pricing, which states its figures are USD; verified on the
 * date `PRICE_TABLE_AS_OF` names. Blast radius: the metered total for `zai` accounts.
 *
 * The mainland platform (bigmodel.cn) is a **different deployment with its own CNY price list**,
 * and it is not this table: an account pointed at it through a base-URL override prices wrong here
 * and should carry an override. Rows are the international USD list only.
 *
 * z.ai's coding plan is a flat $18/month over the same model ids, not a separate SKU — which is
 * precisely why the subscription question is answered on the **Account** (`AccountBilling`) rather
 * than by a model name or a provider id. An account on that plan reports these numbers as
 * `notional`, not as spend.
 */
export const ZAI_MODELS: ModelTable = {
  /**
   * The current flagship, and what the coding plan runs on. Listed on the vendor's pricing page
   * (docs.z.ai/guides/overview/pricing, read 2026-10-15) at the same figures as its 5.2/5.1
   * siblings, with no cache-write price published (the cache-storage column is a limited-time
   * freebie, not a write rate).
   */
  "glm-5.3": rates(1.4, 4.4, { read: 0.26 }),
  "glm-5.2": rates(1.4, 4.4, { read: 0.26 }),
  "glm-5.1": rates(1.4, 4.4, { read: 0.26 }),
  "glm-5": rates(1, 3.2, { read: 0.2 }),
  "glm-5-turbo": rates(1.2, 4, { read: 0.24 }),
  /**
   * Listed at docs.z.ai/guides/overview/pricing on 2026-10-15 at the figures OpenRouter already
   * charged (input 0.15, output 0.50, cached read 0.03 USD per Mtok), so the row's numbers stand
   * and only its source moved from the reseller to the vendor.
   */
  "glm-5.3-flash": rates(0.15, 0.5, { read: 0.03 }),
  "glm-4.7": rates(0.6, 2.2, { read: 0.11 }),
  "glm-4.7-flashx": rates(0.07, 0.4, { read: 0.01 }),
  "glm-4.6": rates(0.6, 2.2, { read: 0.11 }),
  "glm-4.5": rates(0.6, 2.2, { read: 0.11 }),
  "glm-4.5-x": rates(2.2, 8.9, { read: 0.45 }),
  "glm-4.5-air": rates(0.2, 1.1, { read: 0.03 }),
  "glm-4.5-airx": rates(1.1, 4.5, { read: 0.22 }),
  "glm-4-32b-0414-128k": rates(0.1, 0.1),
  /**
   * Published at zero, which is a price rather than a missing one — the two Flash models are free
   * on this platform. A zero here is therefore a measurement and reports as `metered $0.000000`,
   * which is the one case where a zero in a spend column is the truth.
   */
  "glm-4.7-flash": rates(0, 0),
  "glm-4.5-flash": rates(0, 0),
}
