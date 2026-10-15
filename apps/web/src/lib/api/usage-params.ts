import { isCustomRange, type UsageRange } from "./usage"

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
