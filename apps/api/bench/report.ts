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

/**
 * The two ceilings non-negotiable 8 promises, as two separate numbers.
 *
 * They are read at different quantiles on purpose, and the asymmetry is measured rather than
 * stylistic. `router_overhead_seconds` is a bucketed histogram fed whole-millisecond samples, so its
 * tail is bounded by the bucket edges and a p99 read off it is stable run to run. Added TTFT is a
 * raw sample series timed across an async relay on a single event loop: its p50 and p95 move under
 * 15% between runs on an idle box, while its **p99 moved 0.56 → 4.03 ms across four consecutive
 * runs of the same unmodified code** — that tail is the scheduler and the collector, not the router.
 * Gating it would be gating noise, and this file's own comment says why that is worse than no gate.
 *
 * p95 loses nothing, because every way the router can actually add time-to-first-token is
 * *systematic* rather than tail-only: buffering the relay, awaiting Postgres or a body parse before
 * the first byte, or a translation that accumulates before it emits all charge every stream, and
 * move p50 and p95 together. A regression that only ever hits one stream in a hundred is not one of
 * the failure modes the budget is about.
 */
export interface Budgets {
  /** `router_overhead_seconds` p99 ceiling, milliseconds. */
  readonly overheadP99Ms: number
  /** Added time-to-first-token p95 ceiling, milliseconds. */
  readonly addedTtftP95Ms: number
}

export interface Verdict {
  readonly rows: readonly Row[]
  readonly budgets: Budgets
  /** Every reason the run failed, in the order they were checked. Empty means it passed. */
  readonly violations: readonly string[]
}

/** Below this, a quantile is the bucket bound the samples were rounded into, not a measurement. */
const QUANTIZED_BELOW_MS = 1

export function verdict(results: readonly ScenarioResult[], budgets: Budgets): Verdict {
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
    if (entry.overheadP99Ms > budgets.overheadP99Ms) {
      violations.push(
        `${entry.scenario}: p99 overhead ${ms(entry.overheadP99Ms)} exceeds the ${budgets.overheadP99Ms} ms budget`,
      )
    }
    if (entry.buffered > 0) {
      violations.push(
        `${entry.scenario}: ${entry.buffered} streams delivered their first byte after the upstream's last — the relay buffered`,
      )
    }
    violations.push(...ttftViolations(entry, budgets.addedTtftP95Ms))
  }

  return { rows, budgets, violations }
}

/**
 * The other half of the budget, which `buffered` alone does not cover.
 *
 * A buffered relay is the *total* failure — first client byte after the upstream's last — and it is
 * the only one the counter can see. The window it leaves open is the whole generation: at the
 * defaults the stub's stream spans `chunks * chunk-gap-ms`, so a router that added 15 ms of latency
 * to the first byte of every stream still buffers nothing and still passes. In production, where a
 * generation runs for seconds, that blind spot is seconds wide. Hence a real ceiling on the number
 * the harness already measures.
 */
function ttftViolations(entry: Row, ceilingMs: number): readonly string[] {
  if (!entry.streamed) return []
  if (entry.addedTtftSamples === 0) {
    return [`${entry.scenario}: streamed, but no time-to-first-token was measured`]
  }
  if (entry.addedTtftP95Ms <= ceilingMs) return []
  return [
    `${entry.scenario}: added time-to-first-token p95 ${ms(entry.addedTtftP95Ms)} exceeds the ${ceilingMs} ms ceiling`,
  ]
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
const TTFT_HEADERS = ["scenario", "streams", "p50", "p95", "p99", "budget", "buffered"]

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
      : entry.overheadP99Ms <= result.budgets.overheadP99Ms
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
    Number.isNaN(entry.addedTtftP95Ms)
      ? "—"
      : entry.addedTtftP95Ms <= result.budgets.addedTtftP95Ms
        ? "ok"
        : "OVER",
    entry.buffered === 0 ? "no" : `YES (${entry.buffered})`,
  ])

  const quantized = result.rows.some((entry) => entry.overheadQuantized)
  const lines = [
    `${OVERHEAD_METRIC} — scraped from GET /metrics, budget ${result.budgets.overheadP99Ms} ms p99`,
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
    `added time-to-first-token — client's first byte minus the upstream's, budget ${result.budgets.addedTtftP95Ms} ms p95`,
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
