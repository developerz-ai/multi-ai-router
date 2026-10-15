import { isCustomRange, type UsageRange } from "./usage-window"

/**
 * The query-string parameters of a usage read, in one place so the summary and the CSV export
 * cannot ask for different windows: a named window is `window=`, a custom range is `from=` and
 * `to=` and no `window`.
 */
export function usageQueryParams(range: UsageRange): Readonly<Record<string, string>> {
  return isCustomRange(range) ? { from: range.from, to: range.to } : { window: range }
}

/** Repeated filter parameters, e.g. `{ owner: ["alice", "bob"] }`, as the server reads them. */
export type UsageFilterParams = Readonly<Record<string, readonly string[]>>

/** The three filters the Usage page offers; the server also reads keyId, poolId and accountId. */
export const USAGE_FILTER_NAMES = ["owner", "tool", "model"] as const
export type UsageFilterName = (typeof USAGE_FILTER_NAMES)[number]

/** Each filter is a list of exact values; an empty list is "no filter", never "match nothing". */
export type UsageFilters = Readonly<Record<UsageFilterName, readonly string[]>>

export const NO_USAGE_FILTERS: UsageFilters = { owner: [], tool: [], model: [] }

export function hasUsageFilters(filters: UsageFilters): boolean {
  return USAGE_FILTER_NAMES.some((name) => filters[name].length > 0)
}

/**
 * Every param of a usage read: the window plus the non-empty filters. Empty lists are left out
 * rather than sent, so an unfiltered read is byte-identical to what it was before filters existed.
 */
export function usageRequestParams(
  range: UsageRange,
  filters: UsageFilters,
): Readonly<Record<string, string | readonly string[]>> {
  const params: Record<string, string | readonly string[]> = { ...usageQueryParams(range) }
  for (const name of USAGE_FILTER_NAMES) {
    if (filters[name].length > 0) params[name] = filters[name]
  }
  return params
}

/**
 * The link the Usage page's Export CSV control points at. Built from the same params the summary
 * query sends, plus any filter params present (repeated, never joined), so a filtered page never
 * exports unfiltered rows.
 */
export function usageExportHref(range: UsageRange, filters?: UsageFilterParams): string {
  const search = new URLSearchParams(usageQueryParams(range))
  for (const [name, values] of Object.entries(filters ?? {})) {
    for (const value of values) search.append(name, value)
  }
  return `/api/admin/usage/export.csv?${search.toString()}`
}
