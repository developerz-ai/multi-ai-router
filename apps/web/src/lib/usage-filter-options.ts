import type { UsageBreakdownRow, UsageSummary } from "./api/usage"
import { USAGE_FILTER_NAMES, type UsageFilterName, type UsageFilters } from "./api/usage-params"

/**
 * The values each usage filter can be set to, read off a summary.
 *
 * Callers pass the **unfiltered** summary for the page's window. Options read from the filtered
 * one would shrink to whatever is already selected, and a second value could never be added.
 * Those rows are the only complete source: the keys list has no models and omits retired keys, and
 * the summary's breakdown tables are capped (`coverage.breakdown.maxRows`), which is why
 * `withSelected` exists.
 */
export type UsageFilterOptions = Readonly<Record<UsageFilterName, readonly string[]>>

const NO_OPTIONS: UsageFilterOptions = { owner: [], tool: [], model: [] }

/** A bucket (`unassigned`, `deleted`, `none`) is not a value anyone can filter on. */
const named = (rows: readonly UsageBreakdownRow[]): readonly string[] =>
  // A Set, so an owner slug used by both a person and a service is one option: the server matches
  // the slug against both kinds.
  [...new Set(rows.filter((row) => row.note === "").map((row) => row.label))]

export function usageFilterOptions(summary: UsageSummary | undefined): UsageFilterOptions {
  if (summary === undefined) return NO_OPTIONS
  return {
    owner: named(summary.byOwner),
    tool: named(summary.byTool),
    model: named(summary.byModel),
  }
}

/**
 * The options, plus any selected value they lack. A deep link can name an owner the capped
 * breakdown no longer lists; it must still show as checked, or the page filters by something the
 * operator cannot see and cannot remove.
 */
export function withSelected(
  options: UsageFilterOptions,
  selected: UsageFilters,
): UsageFilterOptions {
  const merged = { ...NO_OPTIONS } as Record<UsageFilterName, readonly string[]>
  for (const name of USAGE_FILTER_NAMES) {
    const missing = selected[name].filter((value) => !options[name].includes(value))
    merged[name] = [...options[name], ...missing]
  }
  return merged
}
