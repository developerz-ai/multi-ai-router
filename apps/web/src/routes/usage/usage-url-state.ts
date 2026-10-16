import { isIsoDateTime } from "@multi-ai-router/core"
import { useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo } from "solid-js"
import {
  isCustomRange,
  USAGE_WINDOWS,
  type UsageRange,
  type UsageWindow,
} from "../../lib/api/usage"
import { USAGE_FILTER_NAMES, type UsageFilters } from "../../lib/api/usage-params"

/**
 * The Usage page's state, kept in the URL so a view can be linked to and a reload keeps it.
 *
 * The names are a contract with the pages that link here (the weekly report's delivery links,
 * #229): `window` (`today` | `7d` | `30d` | `lifetime`) or a custom `from` and `to` (ISO-8601),
 * plus `owner`, `tool` and `model`, each repeated once per value (`?owner=alice&owner=bob`).
 * They are the API's own parameter names, so the URL reads the same as the request it causes.
 *
 * The default window, 7 days, is the absence of a param: a fresh visit to `/usage` is a clean URL.
 * Anything the server would refuse (an unknown window, a half-given or backwards range) falls
 * back to the default rather than being forwarded, and nothing outside `owner`/`tool`/`model` is
 * ever read as a filter: the server answers `400` to an unknown key.
 */

export const DEFAULT_USAGE_WINDOW: UsageWindow = "7d"

/** What `useSearchParams` hands back: a repeated key arrives as a list, a single one as a string. */
export type RawUsageParams = Readonly<Record<string, string | readonly string[] | undefined>>

/** What `setSearchParams` takes. `undefined` removes the key, so every name is always written. */
export type UsageUrlParams = Readonly<Record<string, string | string[] | undefined>>

export interface UsageUrlState {
  readonly range: UsageRange
  readonly filters: UsageFilters
}

function valuesOf(raw: string | readonly string[] | undefined): readonly string[] {
  const list = raw === undefined ? [] : typeof raw === "string" ? [raw] : raw
  return [...new Set(list.filter((value) => value.length > 0))]
}

function single(raw: string | readonly string[] | undefined): string | undefined {
  return valuesOf(raw)[0]
}

function windowOf(raw: string | undefined): UsageWindow | undefined {
  return USAGE_WINDOWS.find((value) => value === raw)
}

/** A custom range only if both ends parse and the start is before the end, as the server requires. */
function customRangeOf(from: string | undefined, to: string | undefined): UsageRange | undefined {
  if (from === undefined || to === undefined) return undefined
  // Only the ISO shape the API validates (the shared schema in @multi-ai-router/core). Anything
  // else Date.parse happens to read (2026/10/01, 10/15/2026) would 400 upstream instead of
  // falling back like every other refused window.
  if (!isIsoDateTime(from) || !isIsoDateTime(to)) return undefined
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return undefined
  return { from, to }
}

export function parseUsageUrl(params: RawUsageParams): UsageUrlState {
  const range =
    customRangeOf(single(params.from), single(params.to)) ??
    windowOf(single(params.window)) ??
    DEFAULT_USAGE_WINDOW
  const filters = Object.fromEntries(
    USAGE_FILTER_NAMES.map((name) => [name, valuesOf(params[name])]),
  ) as UsageFilters
  return { range, filters }
}

/** Every param the page owns, so setting a named window clears a stale custom range and back. */
export function usageUrlParams(range: UsageRange, filters: UsageFilters): UsageUrlParams {
  const custom = isCustomRange(range)
  return {
    window: custom || range === DEFAULT_USAGE_WINDOW ? undefined : range,
    from: custom ? range.from : undefined,
    to: custom ? range.to : undefined,
    ...Object.fromEntries(
      USAGE_FILTER_NAMES.map((name) => [
        name,
        filters[name].length > 0 ? [...filters[name]] : undefined,
      ]),
    ),
  }
}

export interface UsageUrlControls {
  readonly range: Accessor<UsageRange>
  readonly filters: Accessor<UsageFilters>
  readonly setRange: (range: UsageRange) => void
  readonly setFilters: (filters: UsageFilters) => void
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

export function useUsageUrlState(): UsageUrlControls {
  const [params, setParams] = useSearchParams()
  const state = createMemo(() => parseUsageUrl(params), parseUsageUrl({}), {
    // The router hands over a fresh object on every navigation; equal values must not wake the
    // page, or typing in an unrelated param would refetch the summary.
    equals: (a, b) =>
      JSON.stringify(a.range) === JSON.stringify(b.range) &&
      USAGE_FILTER_NAMES.every((name) => sameList(a.filters[name], b.filters[name])),
  })
  const range = createMemo(() => state().range)
  const filters = createMemo(() => state().filters)

  return {
    range,
    filters,
    setRange: (next) => setParams(usageUrlParams(next, filters())),
    setFilters: (next) => setParams(usageUrlParams(range(), next)),
  }
}
