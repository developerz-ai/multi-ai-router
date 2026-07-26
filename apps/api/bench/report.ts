import { histogramMean, histogramQuantile, parseHistogram, sampleQuantile } from "./quantiles"
import type { ScenarioResult } from "./scenarios"

/**
 * Turning a driven scenario into the two verdicts and the table that justifies them.
 *
 * Pure: results in, rows and a pass/fail out. No app, no clock, no printing — `run.ts` decides
 * where the text goes and what the process exits with.
 *
 * The row carries `overheadQuantized` because the honesty of the report depends on it.
 * `router_overhead_seconds` is fed `UsageRecord.routerOverheadMs`, which is whole milliseconds, so
 * every sample below half a millisecond lands in the same bucket and *every* quantile under 1 ms is
 * a bucket bound rather than a measurement. Printing `p99 0.50 ms` without saying so would invite
 * exactly the false precision this file exists to avoid; the mean, which divides an accumulated sum
 * by the sample count, is the number that actually has sub-millisecond resolution.
 */

export const OVERHEAD_METRIC = "router_overhead_seconds"

export interface Row {
  readonly scenario: string
  readonly path: string
  readonly samples: number
  readonly failures: number
  /** Milliseconds. NaN when the scenario recorded nothing. */
  readonly overheadMeanMs: number
  readonly overheadP50Ms: number
  readonly overheadP95Ms: number
  readonly overheadP99Ms: number
  /** True while the samples mostly round into the first bucket, making the quantiles bounds. */
  readonly overheadQuantized: boolean
  /** Added time-to-first-token, milliseconds. NaN for a non-streamed scenario. */
  readonly addedTtftSamples: number
  readonly addedTtftP50Ms: number
  readonly addedTtftP95Ms: number
  readonly addedTtftP99Ms: number
  readonly buffered: number
  readonly streamed: boolean
}

export interface Verdict {
  readonly rows: readonly Row[]
  readonly budgetMs: number
  /** Every reason the run failed, in the order they were checked. Empty means it passed. */
  readonly violations: readonly string[]
}

/** Below this, a quantile is the bucket bound the samples were rounded into, not a measurement. */
const QUANTIZED_BELOW_MS = 1

export function verdict(results: readonly ScenarioResult[], budgetMs: number): Verdict {
  const rows = results.map(row)
  const violations: string[] = []

  for (const entry of rows) {
    if (entry.failures > 0) {
      violations.push(`${entry.scenario}: ${entry.failures} of ${entry.samples} requests failed`)
    }
    if (entry.samples === 0 || Number.isNaN(entry.overheadP99Ms)) {
      violations.push(`${entry.scenario}: ${OVERHEAD_METRIC} recorded no samples`)
      continue
    }
    if (entry.overheadP99Ms > budgetMs) {
      violations.push(
        `${entry.scenario}: p99 overhead ${ms(entry.overheadP99Ms)} exceeds the ${budgetMs} ms budget`,
      )
    }
    if (entry.buffered > 0) {
      violations.push(
        `${entry.scenario}: ${entry.buffered} streams delivered their first byte after the upstream's last — the relay buffered`,
      )
    }
  }

  return { rows, budgetMs, violations }
}

function row(result: ScenarioResult): Row {
  const series = parseHistogram(result.exposition, OVERHEAD_METRIC).find(
    (candidate) => candidate.labels.path === result.scenario.path,
  )
  const empty = { labels: {}, buckets: [], sum: 0, count: 0 }
  const found = series ?? empty
  const mean = histogramMean(found) * 1_000

  return {
    scenario: result.scenario.name,
    path: result.scenario.path,
    samples: found.count,
    failures: result.failures,
    overheadMeanMs: mean,
    overheadP50Ms: histogramQuantile(found, 0.5) * 1_000,
    overheadP95Ms: histogramQuantile(found, 0.95) * 1_000,
    overheadP99Ms: histogramQuantile(found, 0.99) * 1_000,
    overheadQuantized: Number.isFinite(mean) && mean < QUANTIZED_BELOW_MS,
    addedTtftSamples: result.addedTtftMs.length,
    addedTtftP50Ms: sampleQuantile(result.addedTtftMs, 0.5),
    addedTtftP95Ms: sampleQuantile(result.addedTtftMs, 0.95),
    addedTtftP99Ms: sampleQuantile(result.addedTtftMs, 0.99),
    buffered: result.buffered,
    streamed: result.scenario.stream,
  }
}

const OVERHEAD_HEADERS = ["scenario", "path", "samples", "mean", "p50", "p95", "p99", "budget"]
const TTFT_HEADERS = ["scenario", "streams", "p50", "p95", "p99", "buffered"]

export function render(result: Verdict): string {
  const overhead = result.rows.map((entry) => [
    entry.scenario,
    entry.path,
    String(entry.samples),
    ms(entry.overheadMeanMs),
    ms(entry.overheadP50Ms),
    ms(entry.overheadP95Ms),
    ms(entry.overheadP99Ms),
    Number.isNaN(entry.overheadP99Ms)
      ? "—"
      : entry.overheadP99Ms <= result.budgetMs
        ? "ok"
        : "OVER",
  ])

  const streams = result.rows.filter((entry) => entry.streamed)
  const ttft = streams.map((entry) => [
    entry.scenario,
    String(entry.addedTtftSamples),
    ms(entry.addedTtftP50Ms),
    ms(entry.addedTtftP95Ms),
    ms(entry.addedTtftP99Ms),
    entry.buffered === 0 ? "no" : `YES (${entry.buffered})`,
  ])

  const quantized = result.rows.some((entry) => entry.overheadQuantized)
  const lines = [
    `${OVERHEAD_METRIC} — scraped from GET /metrics, budget ${result.budgetMs} ms p99`,
    "",
    table(OVERHEAD_HEADERS, overhead),
  ]
  if (quantized) {
    lines.push(
      "",
      "  The percentiles above are bucket bounds, not measurements: the series is fed whole",
      "  millisecond samples, so a sub-millisecond overhead rounds into the first bucket and every",
      "  quantile inside it reports that bucket's edge. The mean divides an accumulated sum by the",
      "  sample count and does have sub-millisecond resolution — read it for the cost, and the",
      "  percentiles for the ceiling.",
    )
  }

  lines.push(
    "",
    "added time-to-first-token — client's first byte minus the upstream's, per streamed request",
    "",
    table(TTFT_HEADERS, ttft),
    "",
    result.violations.length === 0
      ? "PASS — under budget on every path, no stream buffered"
      : result.violations.map((violation) => `FAIL — ${violation}`).join("\n"),
  )
  return lines.join("\n")
}

function ms(value: number): string {
  if (Number.isNaN(value)) return "—"
  return `${value.toFixed(2)} ms`
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((entry) => (entry[column] ?? "").length)),
  )
  const line = (cells: readonly string[]) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}`.trimEnd()

  return [
    line(headers),
    `  ${widths.map((width) => "-".repeat(width)).join("  ")}`,
    ...rows.map(line),
  ].join("\n")
}
