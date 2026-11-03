import { type ModelTable, rates, tiered } from "../rates"

/**
 * xAI's published per-Mtok Grok prices.
 *
 * Provenance: docs.x.ai/docs/models (the Text API price table) and the model manifest beside it,
 * read 2026-11-03. Blast radius: the metered total for `xai` accounts.
 *
 * Every current model is tiered at 200k, and xAI's rule is the strict one: once the prompt reaches
 * the threshold, the **whole** request bills at the long rate — which is exactly what
 * {@link tiered} expresses.
 *
 * The 2026-05-15 retirement took `grok-4`, `grok-4-fast-*`, `grok-3` and `grok-3-mini` off the
 * price list. The retired slugs still resolve, and all but one redirect to `grok-4.3` and bill at
 * its rates — but a redirect is the vendor's routing decision, not a published price for the name
 * the client sent, so they are absent here and price as unknown rather than as a guess about where
 * a name currently points.
 *
 * The `grok-code-fast*` names are **published aliases** of `grok-build-0.1` — xAI's own model
 * manifest lists them as such — so they carry that model's card under their own names.
 */

/** The prompt size at which every current Grok model switches to its long-context rate. */
const LONG_CONTEXT_FROM = 200_000

/** The flagship. */
const GROK_4_7 = tiered(rates(2, 6, { read: 0.5 }), LONG_CONTEXT_FROM, rates(4, 12, { read: 1 }))

/** The 4.6 card, which the flagship shares. */
const GROK_4_6 = GROK_4_7

/** The 4.5 rate, with its own cached-input price. */
const GROK_4_5 = tiered(rates(2, 6, { read: 0.3 }), LONG_CONTEXT_FROM, rates(4, 12, { read: 0.6 }))

/** The 4.3 rate, which the whole 4.20 line also bills at. */
const GROK_4_3 = tiered(
  rates(1.25, 2.5, { read: 0.2 }),
  LONG_CONTEXT_FROM,
  rates(2.5, 5, { read: 0.4 }),
)

/** The coding model, under its own name and the three `grok-code-fast` spellings that alias it. */
const GROK_BUILD = tiered(rates(1, 2, { read: 0.2 }), LONG_CONTEXT_FROM, rates(2, 4, { read: 0.4 }))

export const XAI_MODELS: ModelTable = {
  "grok-4.7": GROK_4_7,
  "grok-4.6": GROK_4_6,
  "grok-4.5": GROK_4_5,
  "grok-4.5-latest": GROK_4_5,
  /** Aliased by `grok-build-latest`. */
  "grok-build-latest": GROK_4_5,
  "grok-4.3": GROK_4_3,
  "grok-4.20-0309-reasoning": GROK_4_3,
  "grok-4.20-0309-non-reasoning": GROK_4_3,
  "grok-4.20-multi-agent-0309": GROK_4_3,
  "grok-build-0.1": GROK_BUILD,
  "grok-code-fast": GROK_BUILD,
  "grok-code-fast-1": GROK_BUILD,
  "grok-code-fast-1-0825": GROK_BUILD,
}
