import type {
  UsageDimension,
  UsageFilter,
  UsageHistoryRepository,
  UsageReadRepository,
} from "@multi-ai-router/db"
import { axisBucketWidth, buildAxis } from "./axis"
import { attributionOf, ownerRows, toolRows } from "./buckets"
import { foldFailures } from "./failures"
import { historySeriesBy, rawBreakdown } from "./group-reads"
import { resolveReadWindow } from "./read-window"
import { groupedFacts, type SummaryFactsReader } from "./summary-facts"
import { alignSeries, breakdownRow, groupSeries, keyNames, label } from "./summary-view"
import type { UsageLabelSets, UsageSummary } from "./types"
import type { UsageWindowQuery } from "./window"

const dimensions: readonly UsageDimension[] = [
  "apiKeyId",
  "accountId",
  "poolId",
  "model",
  "owner",
  "tool",
]

export async function readSummary(
  deps: {
    history: UsageHistoryRepository
    raw: UsageReadRepository
    labels: UsageLabelSets
    now: () => Date
    maxChartPoints?: number
    breakdownMaxRows?: number
    /** Totals + per-dimension breakdowns. Absent: one `GROUPING SETS` statement (`groupedFacts`). */
    facts?: SummaryFactsReader
  },
  query: UsageWindowQuery,
  filter: UsageFilter,
): Promise<UsageSummary> {
  const window = await resolveReadWindow(deps.history, query)
  // Unfiltered on purpose: coverage asks "is any history in this window pending or legacy", and a
  // superset can only over-report `incomplete`, the safe direction (docs/idea/08-observability.md).
  const coverage = await deps.history.coverage(window)
  const maxChartPoints = deps.maxChartPoints ?? 400
  const maxRows = deps.breakdownMaxRows ?? 100
  const width = axisBucketWidth(window, maxChartPoints)
  // One mapping for every owner/tool query below, so their group keys cannot disagree.
  const attribution = attributionOf(deps.labels.keys)
  const readFacts = deps.facts ?? groupedFacts(deps.history)
  const [{ totals, breakdowns: rows }, latency, series, outcomes] = await Promise.all([
    readFacts({ window, filter, dimensions, limit: maxRows + 1, attribution }),
    deps.raw.latency(window, filter),
    deps.history.series(window, window.bucket, width, filter),
    deps.raw.outcomes(window, filter),
  ])
  const axis = buildAxis(window, width)
  const retainedAttempts = outcomes.reduce((sum, row) => sum + row.attempts, 0)
  const incomplete = coverage.incomplete || retainedAttempts > totals.attempts
  const failures = foldFailures(outcomes, totals.attempts, incomplete)
  const selected = rows.map((group) => group.slice(0, maxRows))
  const diagnostics = await Promise.all(
    dimensions.map((dimension, index) =>
      rawBreakdown(
        deps.raw,
        window,
        dimension,
        (selected[index] ?? []).map((row) => row.id),
        maxRows,
        filter,
        attribution,
      ),
    ),
  )
  const limited = selected.map((group, index) => {
    const measured = new Map((diagnostics[index] ?? []).map((row) => [row.id, row]))
    return group.map((row) => ({
      ...row,
      latencyP50Ms: measured.get(row.id)?.latencyP50Ms ?? null,
      latencyP95Ms: measured.get(row.id)?.latencyP95Ms ?? null,
      routerOverheadP95Ms: measured.get(row.id)?.routerOverheadP95Ms ?? null,
    }))
  })
  const seriesByDimension = await Promise.all(
    dimensions.map((dimension, index) =>
      historySeriesBy(
        deps.history,
        window,
        window.bucket,
        dimension,
        width,
        (limited[index] ?? []).map((row) => row.id),
        filter,
        attribution,
      ),
    ),
  )
  const [keys, accounts, pools, models, owners, tools] = limited
  const [keySeries, accountSeries, poolSeries, modelSeries, ownerSeries, toolSeries] =
    seriesByDimension.map((points) => groupSeries(axis, points))
  return {
    window: window.label,
    bucket: window.bucket,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    totals,
    latency,
    failures,
    coverage: {
      timeBasis: coverage.timeBasis,
      requestsBasis: coverage.requestsBasis,
      historicalPrecision: coverage.historicalPrecision,
      legacy: coverage.legacy,
      incomplete,
      bucketWidth: width,
      maxChartPoints,
      retainedDetail: {
        from: coverage.rawFrom?.toISOString() ?? null,
        to: coverage.rawTo?.toISOString() ?? null,
        attempts: failures.attempts,
        totalAttempts: totals.attempts,
        partial: failures.partial,
      },
      breakdown: {
        maxRows,
        truncated: dimensions.filter((_, i) => (rows[i]?.length ?? 0) > maxRows),
      },
    },
    axis,
    series: alignSeries(axis, series),
    byKey: label(keys ?? [], keyNames(deps.labels.keys), axis, keySeries ?? new Map()).map(
      (row) => ({
        ...row,
        retired: row.id !== null && deps.labels.keys.get(row.id)?.retired === true,
      }),
    ),
    byAccount: label(accounts ?? [], deps.labels.accounts, axis, accountSeries ?? new Map()),
    byPool: label(pools ?? [], deps.labels.pools, axis, poolSeries ?? new Map()),
    byModel: (models ?? []).map((row) => ({
      ...breakdownRow(row, axis, modelSeries ?? new Map()),
      label: row.id,
      note: row.id === null ? "none" : null,
    })),
    byOwner: ownerRows(owners ?? [], axis, ownerSeries ?? new Map()),
    byTool: toolRows(tools ?? [], axis, toolSeries ?? new Map()),
  }
}
