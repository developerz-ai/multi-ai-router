/**
 * Reading the router's own histogram back out of its `/metrics` exposition.
 *
 * The bench times almost nothing itself. `router_overhead_seconds` already exists, it is already
 * the number an operator alerts on, and a stopwatch wrapped around `app.request()` would measure a
 * *different* quantity — one that no dashboard shows and no regression alert watches. So the bench
 * drives traffic and then asks the router what it recorded, through the same `GET /metrics` a
 * Prometheus would scrape.
 *
 * Everything here is pure: text in, numbers out. No clock, no I/O, no app.
 *
 * **Resolution.** The series is fed `UsageRecord.routerOverheadMs`, which is whole milliseconds —
 * so its four sub-millisecond buckets can only ever hold "rounded to zero". Quantiles below 1 ms
 * are therefore bucket bounds, not measurements, and the honest sub-millisecond number is the mean
 * (`_sum / _count`), which recovers precision from the sample count instead of from the buckets.
 * The report says so out loud rather than printing `0.50 ms` as though anyone measured it.
 */

export interface Bucket {
  /** Upper bound, inclusive. `+Inf` parses as `Number.POSITIVE_INFINITY`. */
  readonly le: number
  /** Cumulative count at this bound, as the exposition format states it. */
  readonly count: number
}

export interface HistogramSeries {
  readonly labels: Readonly<Record<string, string>>
  /** Ascending by `le`, `+Inf` last. */
  readonly buckets: readonly Bucket[]
  readonly sum: number
  readonly count: number
}

/** Every series of one histogram family, keyed by its label set, in first-seen order. */
export function parseHistogram(exposition: string, metric: string): HistogramSeries[] {
  const found = new Map<
    string,
    { labels: Record<string, string>; buckets: Bucket[]; sum: number; count: number }
  >()

  for (const line of exposition.split("\n")) {
    const parsed = parseLine(line)
    if (parsed === null) continue

    const suffix = suffixOf(parsed.name, metric)
    if (suffix === null) continue

    const { le, ...labels } = parsed.labels
    const key = seriesKey(labels)
    const series = found.get(key) ?? { labels, buckets: [], sum: 0, count: 0 }
    found.set(key, series)

    if (suffix === "_bucket" && le !== undefined)
      series.buckets.push({ le: bound(le), count: parsed.value })
    else if (suffix === "_sum") series.sum = parsed.value
    else if (suffix === "_count") series.count = parsed.value
  }

  return [...found.values()].map((series) => ({
    ...series,
    buckets: [...series.buckets].sort((a, b) => a.le - b.le),
  }))
}

/**
 * Prometheus' own `histogram_quantile`, reimplemented so a number printed by `bin/bench` is the
 * number an operator would read off the same series in Grafana — including its habits: linear
 * interpolation inside the bucket the rank lands in, a lower bound of zero for the first bucket,
 * and the highest *finite* bound when the rank lands in `+Inf` (an infinity nobody can act on).
 *
 * Returns NaN for an empty series. That is not a failure — it is "this path was never exercised",
 * which the report prints as such rather than as a zero somebody might read as a good result.
 */
export function histogramQuantile(series: HistogramSeries, q: number): number {
  const buckets = series.buckets
  if (series.count === 0 || buckets.length === 0) return Number.NaN

  const rank = q * series.count
  const index = indexFor(buckets, rank)
  const bucket = buckets[index]
  if (bucket === undefined) return Number.NaN
  if (!Number.isFinite(bucket.le)) return buckets[buckets.length - 2]?.le ?? Number.NaN

  const previous = index === 0 ? undefined : buckets[index - 1]
  const lowerBound = previous?.le ?? 0
  const lowerCount = previous?.count ?? 0
  const span = bucket.count - lowerCount
  if (span <= 0) return bucket.le
  return lowerBound + ((rank - lowerCount) / span) * (bucket.le - lowerBound)
}

/** Mean observation, the one sub-bucket-resolution number a histogram carries. NaN when empty. */
export function histogramMean(series: HistogramSeries): number {
  return series.count === 0 ? Number.NaN : series.sum / series.count
}

/**
 * Quantile of raw samples the bench collected itself, ascending. Used only for added
 * time-to-first-token, which no series records — see `scenarios.ts` for why it cannot.
 */
export function sampleQuantile(ascending: readonly number[], q: number): number {
  if (ascending.length === 0) return Number.NaN
  const rank = (ascending.length - 1) * q
  const low = Math.floor(rank)
  const lower = ascending[low]
  if (lower === undefined) return Number.NaN
  const upper = ascending[Math.ceil(rank)] ?? lower
  return lower + (upper - lower) * (rank - low)
}

const SUFFIXES = ["_bucket", "_sum", "_count"] as const

function suffixOf(name: string, metric: string): (typeof SUFFIXES)[number] | null {
  for (const suffix of SUFFIXES) {
    if (name === `${metric}${suffix}`) return suffix
  }
  return null
}

function indexFor(buckets: readonly Bucket[], rank: number): number {
  const found = buckets.findIndex((bucket) => bucket.count >= rank)
  return found === -1 ? buckets.length - 1 : found
}

function bound(le: string): number {
  return le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le)
}

/** Identity of one series: its labels, sorted, JSON-encoded so no value can forge a separator. */
function seriesKey(labels: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((name) => [name, labels[name] ?? ""])
  return JSON.stringify(sorted)
}

interface ParsedLine {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
}

function parseLine(line: string): ParsedLine | null {
  const text = line.trim()
  if (text.length === 0 || text.startsWith("#")) return null

  const open = text.indexOf("{")
  if (open === -1) {
    const space = text.indexOf(" ")
    if (space === -1) return null
    return { name: text.slice(0, space), labels: {}, value: Number(text.slice(space + 1)) }
  }

  const close = text.lastIndexOf("}")
  if (close < open) return null
  return {
    name: text.slice(0, open),
    labels: parseLabels(text.slice(open + 1, close)),
    value: Number(text.slice(close + 1)),
  }
}

const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const match of text.matchAll(LABEL)) {
    const [, name, value] = match
    if (name === undefined || value === undefined) continue
    labels[name] = value.replace(/\\(.)/g, (_whole, escaped: string) =>
      escaped === "n" ? "\n" : escaped,
    )
  }
  return labels
}
