import type { ProviderId } from "@multi-ai-router/core"
import { request } from "./client"

// `/api/admin/settings` — what the router is configured to do, and the one part
// of it an operator may change from the console.
//
// Retention windows, the log level and the janitor interval are environment
// variables read once at boot (docs/idea/09-deployment.md), so they arrive here
// as facts and the screen renders no control for them. Prices are the exception,
// and the PATCH takes the **complete set**: what is sent replaces what is
// stored, so `[]` clears every override. A merge-by-key body could not express
// "remove this one" without a second endpoint.
//
// Scheduled-task health is `./tasks.ts`, the audit log is `./audit.ts` — three
// endpoints, three modules, the same convention as the rest of this directory.

export interface RetentionWindows {
  readonly usageDays: number
  readonly auditDays: number
  readonly sessionsHours: number
  readonly revokedKeysDays: number
  readonly oauthStateMinutes: number
}

/** US dollars per million tokens — the unit the shipped table and every override use. */
export interface ModelRates {
  readonly inputPerMtok: number
  readonly outputPerMtok: number
  readonly cacheReadPerMtok: number
  readonly cacheWritePerMtok: number
}

export type RateField = keyof ModelRates

export const RATE_FIELDS: readonly RateField[] = [
  "inputPerMtok",
  "outputPerMtok",
  "cacheReadPerMtok",
  "cacheWritePerMtok",
]

/** One priced `(provider, model)` pair. The same model costs different money upstream to upstream. */
export interface PriceRate extends ModelRates {
  readonly provider: ProviderId
  readonly model: string
  /**
   * Present on a **long-context row** in `shipped`: the prompt size at which this card replaces the
   * standard one, so a tiered model arrives as two entries under the same name.
   *
   * Never sent on an override, and never editable. An override is one rate for one provider +
   * model — writing one is the operator saying "this is the price, whatever the prompt" — so the
   * merge below folds the tier onto its model as a read-only annotation rather than a second row.
   */
  readonly fromPromptTokens?: number
}

/** A model's long-context tier, as the table displays it. */
export interface LongContextRates extends ModelRates {
  readonly fromPromptTokens: number
}

/** The operator's row for that pair. It wins over the shipped rate; it never merges with it. */
export interface PriceOverride extends PriceRate {
  readonly updatedAt: string
}

export interface PriceTable {
  /**
   * The day the shipped rows were last checked against their vendors, `YYYY-MM-DD`. Rendered
   * beside the table: vendors reprice without asking, and a price table nobody can date is a table
   * nobody can judge.
   */
  readonly shippedAsOf: string
  readonly shipped: readonly PriceRate[]
  readonly overrides: readonly PriceOverride[]
}

export interface SettingsView {
  /**
   * The build the **server** is running, not the one this bundle was cut from.
   * A console left open across a deploy, or reloaded from a stale cache, would
   * otherwise report a version nothing is serving — which is the one number a
   * bug report has to get right.
   */
  readonly version: string
  readonly retention: RetentionWindows
  readonly logLevel: string
  readonly janitorIntervalMinutes: number
  readonly prices: PriceTable
  /** The configured `PUBLIC_URL`, or null. The onboarding panel's base URL falls back to this tab's own origin when null. */
  readonly publicUrl: string | null
}

/**
 * `added` is an **extension**, not an edit: an override for a model the image
 * does not price has nothing to revert to, and removing it un-prices the model
 * rather than restoring a number.
 */
export type PriceOrigin = "shipped" | "overridden" | "added"

export interface PriceRow {
  /** `provider:model` — the row's identity in a table and in an edit map. */
  readonly id: string
  readonly provider: ProviderId
  readonly model: string
  readonly origin: PriceOrigin
  /** What the image prices this at, or null when the image does not price it at all. */
  readonly shipped: ModelRates | null
  /** What cost estimation uses: the override when there is one, the shipped rate otherwise. */
  readonly rates: ModelRates
  /**
   * The shipped long-context tier for this model, when it has one. Display only: an override on
   * this row replaces it, which is what makes it worth showing beside the editable numbers.
   */
  readonly longContext: LongContextRates | null
  readonly updatedAt: string | null
}

export function priceRowId(provider: string, model: string): string {
  return `${provider}:${model}`
}

export function sameRates(a: ModelRates, b: ModelRates): boolean {
  return RATE_FIELDS.every((field) => a[field] === b[field])
}

/**
 * A row counts as overridden only when its rates **differ** from the shipped
 * ones. An override that restates the shipped price is not a departure, so it
 * classifies as shipped and a save drops it: the stored table holds differences
 * from the image, never a copy of it.
 */
function classify(shipped: ModelRates | null, rates: ModelRates): PriceOrigin {
  if (shipped === null) return "added"
  return sameRates(shipped, rates) ? "shipped" : "overridden"
}

function ratesOf(rate: ModelRates): ModelRates {
  return {
    inputPerMtok: rate.inputPerMtok,
    outputPerMtok: rate.outputPerMtok,
    cacheReadPerMtok: rate.cacheReadPerMtok,
    cacheWritePerMtok: rate.cacheWritePerMtok,
  }
}

/** One row per `(provider, model)` across `shipped ∪ overrides`, ordered for a human to scan. */
export function mergePriceRows(
  shipped: readonly PriceRate[],
  overrides: readonly PriceOverride[],
): readonly PriceRow[] {
  const rows = new Map<string, PriceRow>()

  // Two passes over `shipped`, because a tiered model arrives as two entries under one name and
  // only the standard one is a row: keying both by `provider:model` would have the second silently
  // replace the first, and the table would show a long-context rate as if it were the ordinary one.
  for (const rate of shipped) {
    if (rate.fromPromptTokens !== undefined) continue
    const id = priceRowId(rate.provider, rate.model)
    rows.set(id, {
      id,
      provider: rate.provider,
      model: rate.model,
      origin: "shipped",
      shipped: ratesOf(rate),
      rates: ratesOf(rate),
      longContext: null,
      updatedAt: null,
    })
  }

  for (const rate of shipped) {
    const from = rate.fromPromptTokens
    if (from === undefined) continue
    const row = rows.get(priceRowId(rate.provider, rate.model))
    if (row !== undefined)
      rows.set(row.id, { ...row, longContext: { ...ratesOf(rate), fromPromptTokens: from } })
  }

  for (const override of overrides) {
    const id = priceRowId(override.provider, override.model)
    const held = rows.get(id)
    const base = held?.shipped ?? null
    rows.set(id, {
      id,
      provider: override.provider,
      model: override.model,
      origin: classify(base, ratesOf(override)),
      shipped: base,
      rates: ratesOf(override),
      longContext: held?.longContext ?? null,
      updatedAt: override.updatedAt,
    })
  }

  return [...rows.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  )
}

/** Re-prices a row and re-classifies it, so an edit back to the shipped number reads as shipped. */
export function withRates(row: PriceRow, rates: ModelRates): PriceRow {
  return { ...row, rates, origin: classify(row.shipped, rates) }
}

/** The complete set the PATCH replaces the stored table with. Rows equal to shipped are dropped. */
export function buildPriceOverridePayload(rows: readonly PriceRow[]): readonly PriceRate[] {
  return rows
    .filter((row) => row.origin !== "shipped")
    .map((row) => ({ provider: row.provider, model: row.model, ...ratesOf(row.rates) }))
}

export interface OverrideDiff {
  /** Stored overrides the payload drops — each reverts to a shipped price or to no price at all. */
  readonly removed: readonly PriceOverride[]
  /** Rows the payload adds or re-prices. */
  readonly changed: readonly PriceRate[]
}

/** What a save would actually do. Drives both the "nothing to save" state and the confirmation. */
export function diffOverrides(
  stored: readonly PriceOverride[],
  payload: readonly PriceRate[],
): OverrideDiff {
  const sent = new Map(payload.map((rate) => [priceRowId(rate.provider, rate.model), rate]))
  const held = new Map(stored.map((rate) => [priceRowId(rate.provider, rate.model), rate]))

  return {
    removed: stored.filter((rate) => !sent.has(priceRowId(rate.provider, rate.model))),
    changed: payload.filter((rate) => {
      const previous = held.get(priceRowId(rate.provider, rate.model))
      return previous === undefined || !sameRates(previous, rate)
    }),
  }
}

export function fetchSettings(): Promise<SettingsView> {
  return request<SettingsView>({ method: "GET", path: "/settings" })
}

/** The array is the complete set: it replaces the stored table, and `[]` clears it. */
export function savePriceOverrides(priceOverrides: readonly PriceRate[]): Promise<SettingsView> {
  return request<SettingsView>({ method: "PATCH", path: "/settings", body: { priceOverrides } })
}
