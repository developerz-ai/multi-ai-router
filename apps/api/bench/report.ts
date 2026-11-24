import { histogramMean, parseHistogram, sampleQuantile } from "./quantiles"
import type { ScenarioResult } from "./scenarios"

/**
 * Turning a driven scenario into the two verdicts and the table that justifies them.
 *
 * Pure: results in, rows and a pass/fail out. No app, no clock, no printing — `run.ts` decides
 * where the text goes and what the process exits with.
 *
 * Two sources per row, on purpose. The overhead quantiles are the bench's own per-request
 * measurement (`ScenarioResult.overheadMs`: client wall time minus the upstream's hold), unrounded,
 * and they are what the budget is held to. Beside them sits what `router_overhead_seconds` recorded
 * for the same requests: its sample count and its mean. The series is fed
 * `UsageRecord.routerOverheadMs`, whole milliseconds, into eight buckets — a quantile read off it is
 * a bucket edge (0.495 ms for every fast scenario, whatever they cost; ~5 ms for anything landing in
 * the 2–5 ms bucket), which reads as a stable number and measures nothing. It stays in the report
 * because it is what an operator alerts on: a series that stopped recording, or whose mean walked
 * away from the measurement, is a finding of its own.
 */

export const OVERHEAD_METRIC = "router_overhead_seconds"

/** The share of a scenario's background streams every measured request must have met. */
export const BACKGROUND_FLOOR = 0.75

export interface Row {
  readonly scenario: string
  readonly path: string
  /** Requests the bench measured an overhead for. */
  readonly samples: number
  readonly failures: number
  /** Measured per request, milliseconds, unrounded. NaN when nothing was measured. */
  readonly overheadMeanMs: number
  readonly overheadP50Ms: number
  readonly overheadP95Ms: number
  readonly overheadP99Ms: number
  /** What `router_overhead_seconds` recorded on this scenario's path: the cross-check. */
  readonly seriesSamples: number
  /** Its `_sum / _count`, milliseconds — the one number the series carries below 1 ms. */
  readonly seriesMeanMs: number
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
 * stylistic. Both are raw sample series timed on a single event loop. Overhead is a whole-request
 * difference of two long spans, and its p99 is the number the non-negotiable names. Added TTFT is
 * one short interval across an async relay: its p50 and p95 move under 15% between runs on an idle
 * box, while its **p99 moved 0.56 → 4.03 ms across four consecutive runs of the same unmodified
 * code** — that tail is the scheduler and the collector, not the router. Gating it would be gating
 * noise, and this file's own comment says why that is worse than no gate.
 *
 * p95 loses nothing, because every way the router can actually add time-to-first-token is
 * *systematic* rather than tail-only: buffering the relay, awaiting Postgres or a body parse before
 * the first byte, or a translation that accumulates before it emits all charge every stream, and
 * move p50 and p95 together. A regression that only ever hits one stream in a hundred is not one of
 * the failure modes the budget is about.
 */
export interface Budgets {
  /** Measured per-request overhead p99 ceiling, milliseconds. */
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

export function verdict(results: readonly ScenarioResult[], budgets: Budgets): Verdict {
  const rows = results.map(row)
  const violations: string[] = []

  for (const entry of rows) {
    if (entry.failures > 0) {
      violations.push(`${entry.scenario}: ${entry.failures} of ${entry.samples} requests failed`)
    }
    if (entry.seriesSamples === 0) {
      violations.push(`${entry.scenario}: ${OVERHEAD_METRIC} recorded no samples`)
      continue
    }
    if (entry.samples === 0 || Number.isNaN(entry.overheadP99Ms)) {
      violations.push(`${entry.scenario}: no request's overhead was measured`)
      continue
    }
    if (entry.overheadP99Ms > budgets.overheadP99Ms) {
      violations.push(
        `${entry.scenario}: p99 overhead ${ms(entry.overheadP99Ms)} exceeds the ${budgets.overheadP99Ms} ms budget`,
      )
    }
    const overlap = results[rows.indexOf(entry)]?.backgroundOverlap
    const wanted = results[rows.indexOf(entry)]?.scenario.backgroundStreams
    if (wanted !== undefined) {
      const least = overlap?.min ?? 0
      // Near the count it names, not merely above zero: one stream in flight is not thirty-two.
      // The slack is for the instant a stream ends and its worker reopens it.
      if (least < Math.ceil(wanted * BACKGROUND_FLOOR)) {
        violations.push(
          `${entry.scenario}: a measured request ran with ${least} of ${wanted} background streams in flight — the load the scenario names was not there`,
        )
      }
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
  const found = series ?? { labels: {}, buckets: [], sum: 0, count: 0 }
  const measured = result.overheadMs

  return {
    scenario: result.scenario.name,
    path: result.scenario.path,
    samples: measured.length,
    failures: result.failures,
    overheadMeanMs:
      measured.length === 0
        ? Number.NaN
        : measured.reduce((sum, value) => sum + value, 0) / measured.length,
    overheadP50Ms: sampleQuantile(measured, 0.5),
    overheadP95Ms: sampleQuantile(measured, 0.95),
    overheadP99Ms: sampleQuantile(measured, 0.99),
    seriesSamples: found.count,
    seriesMeanMs: histogramMean(found) * 1_000,
    addedTtftSamples: result.addedTtftMs.length,
    addedTtftP50Ms: sampleQuantile(result.addedTtftMs, 0.5),
    addedTtftP95Ms: sampleQuantile(result.addedTtftMs, 0.95),
    addedTtftP99Ms: sampleQuantile(result.addedTtftMs, 0.99),
    buffered: result.buffered,
    streamed: result.scenario.stream,
  }
}

const OVERHEAD_HEADERS = [
  "scenario",
  "path",
  "samples",
  "mean",
  "p50",
  "p95",
  "p99",
  "budget",
  "series mean",
]
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
    ms(entry.seriesMeanMs),
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

  const lines = [
    `router overhead — measured per request (how late the router made it: before the upstream, then the worse of its tail and its latest stream token), budget ${result.budgets.overheadP99Ms} ms p99`,
    "",
    table(OVERHEAD_HEADERS, overhead),
    "",
    `  "series mean" is what ${OVERHEAD_METRIC} recorded for the same requests, scraped from GET`,
    "  /metrics. It is fed whole milliseconds, so it under-reads a sub-millisecond cost and its",
    "  percentiles are bucket edges; it is shown to prove the series still records, not as the cost.",
  ]

  lines.push(
    "",
    `added time-to-first-token — client's wait for a first byte from request start, less the upstream's own, budget ${result.budgets.addedTtftP95Ms} ms p95`,
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
