import type { PriceRateView } from "./schema"

/**
 * What a settings change is allowed to say about itself.
 *
 * The audit log records **names and counts, never values** — docs/idea/08-observability.md
 * ("`settings.changed` | setting name, old → new (secret-valued settings record the name only)").
 * A price table is not secret, but dumping every edited row into `detail` would put an unbounded
 * blob in an append-only table that only the janitor can ever shrink, and the operator question the
 * log answers is *"who changed the prices, and when"* — not *"what were they"*, which the table
 * itself already holds. So the diff is reduced to three integers here, in one tested place, rather
 * than assembled ad hoc at the call site.
 */

/**
 * The setting's stable name, and its audit subject id — a setting has no row, so the name is what
 * `AUDIT_SUBJECTS.settings` events are filtered by. Chosen here and never by a caller, which is what
 * keeps it usable as a filter. One value today; the constant exists because it will not stay one.
 */
export const PRICE_OVERRIDES_SETTING = "price_overrides"

export interface PriceOverrideDiff {
  readonly added: number
  readonly removed: number
  readonly changed: number
}

/**
 * Counts the edit, keyed by `(provider, model)` — the pair the unique index is on, so it is the
 * same identity the storage layer uses. A row whose rates are byte-identical counts as neither
 * changed nor added: re-saving a screen nobody edited must not read as an edit.
 */
export function diffPriceOverrides(
  before: readonly PriceRateView[],
  after: readonly PriceRateView[],
): PriceOverrideDiff {
  const previous = new Map(before.map((row) => [pairKey(row), row]))
  let added = 0
  let changed = 0

  for (const row of after) {
    const was = previous.get(pairKey(row))
    if (was === undefined) {
      added += 1
    } else if (!sameRates(was, row)) {
      changed += 1
    }
  }

  const kept = after.length - added
  return { added, removed: before.length - kept, changed }
}

/** The detail the event carries: the setting's name and how much of it moved. Nothing else. */
export function priceOverrideAuditDetail(diff: PriceOverrideDiff): Record<string, unknown> {
  return {
    setting: PRICE_OVERRIDES_SETTING,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
  }
}

function pairKey(rate: PriceRateView): string {
  return `${rate.provider}/${rate.model}`
}

function sameRates(a: PriceRateView, b: PriceRateView): boolean {
  return (
    a.inputPerMtok === b.inputPerMtok &&
    a.outputPerMtok === b.outputPerMtok &&
    a.cacheReadPerMtok === b.cacheReadPerMtok &&
    a.cacheWritePerMtok === b.cacheWritePerMtok
  )
}
