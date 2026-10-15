import type {
  UsageDimension,
  UsageFilter,
  UsageHistoryRepository,
  UsageReadRepository,
} from "@multi-ai-router/db"
import { axisBucketWidth, buildAxis } from "./axis"
import { foldFailures } from "./failures"
import { alignSeries, breakdownRow, keyNames, label } from "./summary-view"
import type { UsageLabelSets, UsageSummary } from "./types"
import { resolveWindow, type UsageWindowQuery } from "./window"

const dimensions: readonly UsageDimension[] = ["apiKeyId", "accountId", "poolId", "model"]

export async function readSummary(
  deps: {
    history: UsageHistoryRepository
    raw: UsageReadRepository
    labels: UsageLabelSets
    now: () => Date
    maxChartPoints?: number
    breakdownMaxRows?: number
  },
  query: UsageWindowQuery,
  filter: UsageFilter,
): Promise<UsageSummary> {
  const initial = await deps.history.coverage()
  const requested = resolveWindow(query, initial.dbNow)
  const window =
    requested.label === "lifetime"
      ? {
          ...requested,
          from:
            initial.earliestAt !== null && initial.earliestAt < requested.to
              ? initial.earliestAt
              : requested.to,
        }
      : requested
  // Unfiltered on purpose: coverage asks "is any history in this window pending or legacy", and a
  // superset can only over-report `incomplete`, the safe direction (docs/idea/08-observability.md).
  const coverage = await deps.history.coverage(window)
  const maxChartPoints = deps.maxChartPoints ?? 400
  const maxRows = deps.breakdownMaxRows ?? 100
  const width = axisBucketWidth(window, maxChartPoints)
  const [totals, latency, series, outcomes, rows] = await Promise.all([
    deps.history.totals(window, filter),
    deps.raw.latency(window, filter),
    deps.history.series(window, window.bucket, width, filter),
    deps.raw.outcomes(window, filter),
    Promise.all(dimensions.map((d) => deps.history.breakdown(window, d, maxRows + 1, filter))),
  ])
  const axis = buildAxis(window, width)
  const retainedAttempts = outcomes.reduce((sum, row) => sum + row.attempts, 0)
  const incomplete = coverage.incomplete || retainedAttempts > totals.attempts
  const failures = foldFailures(outcomes, totals.attempts, incomplete)
  const selected = rows.map((group) => group.slice(0, maxRows))
  const diagnostics = await Promise.all(
    dimensions.map((dimension, index) =>
      deps.raw.breakdown(
        window,
        dimension,
        (selected[index] ?? []).map((row) => row.id),
        maxRows,
        filter,
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
  const groupSeries = await Promise.all(
    dimensions.map((dimension, index) =>
      deps.history.seriesByDimension(
        window,
        window.bucket,
        dimension,
        width,
        (limited[index] ?? []).map((row) => row.id),
        filter,
      ),
    ),
  )
  const [keys, accounts, pools, models] = limited
  const [keySeries, accountSeries, poolSeries, modelSeries] = groupSeries
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
    byKey: label(keys ?? [], keyNames(deps.labels.keys), axis, keySeries ?? []),
    byAccount: label(accounts ?? [], deps.labels.accounts, axis, accountSeries ?? []),
    byPool: label(pools ?? [], deps.labels.pools, axis, poolSeries ?? []),
    byModel: (models ?? []).map((row) => ({
      ...breakdownRow(row, axis, modelSeries ?? []),
      label: row.id,
      note: row.id === null ? "none" : null,
    })),
  }
}
