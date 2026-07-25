import type {
  ModelRates,
  OverrideDiff,
  PriceOrigin,
  PriceRate,
  RateField,
  SettingsView,
} from "../../lib/api/settings"
import { RATE_FIELDS } from "../../lib/api/settings"

// The text layer of the price editor, and the sentences a save has to say.
//
// A rate is a number to the router and a string to the operator, and the gap
// between them is where a half-typed `0.` must not become a stored price. Every
// conversion is here, pure, so the section component holds signals and markup
// and nothing else.

export type RateDraft = Readonly<Record<RateField, string>>

export const RATE_HEADERS: Readonly<Record<RateField, string>> = {
  inputPerMtok: "Input",
  outputPerMtok: "Output",
  cacheReadPerMtok: "Cache read",
  cacheWritePerMtok: "Cache write",
}

export const ORIGIN_TONE: Readonly<Record<PriceOrigin, "neutral" | "accent" | "warn">> = {
  shipped: "neutral",
  overridden: "accent",
  added: "warn",
}

/**
 * A new row starts **empty**, not at zero. Zero is a price — "this model is
 * free" — and a row left unfilled must block the save rather than quietly claim
 * one.
 */
export const EMPTY_DRAFT: RateDraft = {
  inputPerMtok: "",
  outputPerMtok: "",
  cacheReadPerMtok: "",
  cacheWritePerMtok: "",
}

export const ZERO_RATES: ModelRates = {
  inputPerMtok: 0,
  outputPerMtok: 0,
  cacheReadPerMtok: 0,
  cacheWritePerMtok: 0,
}

export function draftOf(rates: ModelRates): RateDraft {
  return {
    inputPerMtok: String(rates.inputPerMtok),
    outputPerMtok: String(rates.outputPerMtok),
    cacheReadPerMtok: String(rates.cacheReadPerMtok),
    cacheWritePerMtok: String(rates.cacheWritePerMtok),
  }
}

/** Null when any cell is not a price. One bad cell invalidates the row, never just itself. */
export function parseDraft(draft: RateDraft): ModelRates | null {
  const input = toRate(draft.inputPerMtok)
  const output = toRate(draft.outputPerMtok)
  const cacheRead = toRate(draft.cacheReadPerMtok)
  const cacheWrite = toRate(draft.cacheWritePerMtok)
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  return {
    inputPerMtok: input,
    outputPerMtok: output,
    cacheReadPerMtok: cacheRead,
    cacheWritePerMtok: cacheWrite,
  }
}

export function toRate(text: string): number | null {
  const value = Number.parseFloat(text.trim())
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** `3 / 15 / 0.3 / 3.75`, in the column order the table shows. */
export function rateSummary(rates: ModelRates): string {
  return RATE_FIELDS.map((field) => rates[field]).join(" / ")
}

export function summarise(view: SettingsView, diff: OverrideDiff): string {
  const stored = `${view.prices.overrides.length} override(s) stored`
  if (diff.removed.length === 0 && diff.changed.length === 0) return `${stored}. Nothing to save.`
  return `${stored}. Saving writes ${diff.changed.length} and removes ${diff.removed.length}.`
}

/** Exactly what each removal costs, named per model rather than "this cannot be undone". */
export function removalConsequences(
  diff: OverrideDiff,
  shipped: readonly PriceRate[],
): readonly string[] {
  const lines = diff.removed.map((override) => {
    const fallback = shipped.find(
      (rate) => rate.provider === override.provider && rate.model === override.model,
    )
    return fallback === undefined
      ? `${override.provider} / ${override.model} loses its only price — its spend is reported as unknown, never as zero.`
      : `${override.provider} / ${override.model} goes back to the shipped price (${rateSummary(fallback)}).`
  })

  const shown = lines.slice(0, 6)
  const rest = lines.length - shown.length
  return [
    ...shown,
    ...(rest > 0 ? [`…and ${rest} more.`] : []),
    "Cost already recorded on usage rows is not recalculated. This changes what future requests are priced at, not history.",
  ]
}
