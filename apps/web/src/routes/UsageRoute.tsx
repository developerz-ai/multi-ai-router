import { createMemo, createSignal, For } from "solid-js"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { TableSkeleton } from "../components/TableSkeleton"
import {
  breakdownFor,
  isCustomRange,
  USAGE_DIMENSIONS,
  USAGE_WINDOWS,
  type UsageDimension,
  usageDimensionLabel,
  usageSummaryWindowLabel,
  usageWindowLabel,
} from "../lib/api/usage"
import { NO_USAGE_FILTERS } from "../lib/api/usage-params"
import { createNow } from "../lib/clock"
import { useAllAccounts } from "../lib/queries/accounts"
import { useUsageSummary } from "../lib/queries/usage"
import { usageFilterOptions, withSelected } from "../lib/usage-filter-options"
import styles from "./UsageRoute.module.scss"
import { UsageBreakdown } from "./usage/UsageBreakdown"
import { UsageChart } from "./usage/UsageChart"
import { UsageCoverage } from "./usage/UsageCoverage"
import { UsageCustomRange } from "./usage/UsageCustomRange"
import { UsageExport } from "./usage/UsageExport"
import { UsageFailures } from "./usage/UsageFailures"
import { UsageFilters } from "./usage/UsageFilters"
import { UsageQuota } from "./usage/UsageQuota"
import { UsageRecent } from "./usage/UsageRecent"
import { UsageReports } from "./usage/UsageReports"
import { UsageTiles } from "./usage/UsageTiles"
import { UsageTopN } from "./usage/UsageTopN"
import { useUsageUrlState } from "./usage/usage-url-state"

/** How many rows a leaderboard shows. Enough to name the outliers, few enough to read at a glance. */
const TOP_N = 5

/**
 * The headline surface: any dimension against any window, with the same measures
 * in every cell.
 *
 * Every figure is measured: `GET /api/admin/usage` aggregates the `UsageRecord`
 * rows the router writes off the request path. `placeholder` stays on the shape
 * so the banner can return the moment any part of this screen is ever fed
 * something generated again.
 *
 * **Metered and notional spend are shown apart and never summed**, here and in
 * every child. Metered is money someone was billed; notional is spend attributed
 * to a flat-fee subscription, where the invoice does not move when the number
 * does. Adding them produces a figure nobody will ever be charged.
 *
 * Quota is its own section rather than a column, for the same reason: a
 * subscription's limit is a window, not a currency, and the two do not belong in
 * one table.
 *
 * The window and the owner, tool and model filters live in the URL (`usage-url-state.ts`), so a
 * view can be linked to; the page's figures, its Export CSV link and its filter options all read
 * that one state.
 *
 * The live feed at the foot of the screen is the one panel here that is not an
 * aggregate. It answers *which* request failed rather than how many did, and it
 * sits outside the summary's `QueryBoundary` so a failing rollup cannot take the
 * diagnosis down with it.
 */
export default function UsageRoute() {
  const now = createNow(30_000)
  const url = useUsageUrlState()
  const [dimension, setDimension] = createSignal<UsageDimension>("key")
  const summary = useUsageSummary(url.range, url.filters)
  // The options come from the unfiltered read of the same window: filtered, they would shrink to
  // the current selection. With no filter set this is the very query above, so it costs nothing.
  const everything = useUsageSummary(url.range, () => NO_USAGE_FILTERS)
  const options = createMemo(() => withSelected(usageFilterOptions(everything.data), url.filters()))
  const accounts = useAllAccounts()

  return (
    <>
      <PageHeader
        actions={
          <>
            {/* The export reads the range and filters the summary query reads, so the file is the
                view on screen. */}
            <UsageExport filters={url.filters()} range={url.range()} />
            {/* A real `<fieldset>` rather than `role="group"`: the grouping is native, so the
                `<legend>` names it for assistive tech without an `aria-label` that can drift
                from the visible wording. */}
            <fieldset class={styles.windows}>
              <legend class={styles.groupLabel}>Window</legend>
              <For each={USAGE_WINDOWS}>
                {(value) => (
                  <button
                    aria-pressed={
                      !isCustomRange(url.range()) && url.range() === value ? "true" : "false"
                    }
                    class={styles.window}
                    onClick={() => url.setRange(value)}
                    type="button"
                  >
                    {usageWindowLabel(value)}
                  </button>
                )}
              </For>
            </fieldset>
          </>
        }
        subtitle="Who burned what — and, in the live feed below, which request failed and why."
        title="Usage"
      />

      {/* Overview's own window picker (`OverviewRoute`) is named-window only — a custom range is
          answered here. */}
      <UsageCustomRange onApply={url.setRange} range={url.range()} />

      <UsageFilters filters={url.filters()} onChange={url.setFilters} options={options()} />

      <QueryBoundary
        errorTitle="Usage could not be loaded"
        loading={<TableSkeleton label="Loading usage" rows={5} />}
        query={summary}
      >
        {(data) => (
          <>
            <UsageCoverage summary={data} />
            <UsageTiles data={data} />

            {/* Directly under the tiles, above the charts: the error-rate tile is the figure an
                operator stops on, and this is the sentence that follows it. */}
            <UsageFailures
              failures={data.failures}
              windowLabel={usageSummaryWindowLabel(data.window)}
            />

            <section aria-label="Requests, attempts and errors over time" class={styles.chart}>
              <p class={styles.chartLabel}>
                Requests, attempts and errors per {data.coverage.bucketWidth} {data.bucket}
                {data.coverage.bucketWidth === 1 ? "" : "s"} ·{" "}
                {usageSummaryWindowLabel(data.window)}
              </p>
              <UsageChart
                bucket={data.bucket}
                bucketWidth={data.coverage.bucketWidth}
                incomplete={data.coverage.incomplete}
                points={data.series}
              />
            </section>

            <fieldset class={styles.dimensions}>
              <legend class={styles.groupLabel}>Break down by</legend>
              <For each={USAGE_DIMENSIONS}>
                {(value) => (
                  <button
                    aria-pressed={dimension() === value ? "true" : "false"}
                    class={styles.dimension}
                    onClick={() => setDimension(value)}
                    type="button"
                  >
                    {usageDimensionLabel(value)}
                  </button>
                )}
              </For>
            </fieldset>

            <UsageTopN
              dimension={dimension()}
              limit={TOP_N}
              rows={breakdownFor(data, dimension())}
            />

            <UsageBreakdown
              bucket={data.bucket}
              dimension={dimension()}
              rows={breakdownFor(data, dimension())}
            />

            <UsageQuota accounts={accounts.data ?? []} failed={accounts.isError} nowMs={now()} />
          </>
        )}
      </QueryBoundary>

      {/* Outside the summary's boundary on purpose, both of these. The reports list and the feed
          are what an operator opens to learn whether something happened, and gating either on the
          aggregate would mean a failing rollup takes them down too. Each has its own query and
          its own error state. */}
      <UsageReports />
      <UsageRecent />
    </>
  )
}
