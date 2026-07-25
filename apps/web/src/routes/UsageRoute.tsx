import { createSignal, For } from "solid-js"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { Sparkline } from "../components/Sparkline"
import { StatTile } from "../components/StatTile"
import { TableSkeleton } from "../components/TableSkeleton"
import {
  breakdownFor,
  USAGE_DIMENSIONS,
  USAGE_WINDOWS,
  type UsageDimension,
  type UsageWindow,
  usageDimensionLabel,
  usageWindowLabel,
} from "../lib/api/usage"
import { createNow } from "../lib/clock"
import { formatCost, formatCount, formatPercent } from "../lib/format"
import { useAllAccounts } from "../lib/queries/accounts"
import { useUsageSummary } from "../lib/queries/usage"
import styles from "./UsageRoute.module.scss"
import { UsageBreakdown } from "./usage/UsageBreakdown"
import { UsageQuota } from "./usage/UsageQuota"
import { UsageTopN } from "./usage/UsageTopN"

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
 */
export default function UsageRoute() {
  const now = createNow(30_000)
  const [window, setWindow] = createSignal<UsageWindow>("7d")
  const [dimension, setDimension] = createSignal<UsageDimension>("key")
  const summary = useUsageSummary(window)
  const accounts = useAllAccounts()

  return (
    <>
      <PageHeader
        actions={
          // A real `<fieldset>` rather than `role="group"`: the grouping is
          // native, so the `<legend>` names it for assistive tech without an
          // `aria-label` that can drift from the visible wording.
          <fieldset class={styles.windows}>
            <legend class={styles.groupLabel}>Window</legend>
            <For each={USAGE_WINDOWS}>
              {(value) => (
                <button
                  aria-pressed={window() === value ? "true" : "false"}
                  class={styles.window}
                  onClick={() => setWindow(value)}
                  type="button"
                >
                  {usageWindowLabel(value)}
                </button>
              )}
            </For>
          </fieldset>
        }
        subtitle="Who burned what — answered without anyone writing a query."
        title="Usage"
      />

      <QueryBoundary
        errorTitle="Usage could not be loaded"
        loading={<TableSkeleton label="Loading usage" rows={5} />}
        query={summary}
      >
        {(data) => (
          <>
            <section aria-label="Headline figures" class={styles.tiles}>
              <StatTile
                label="Requests"
                note={`Client-facing · ${usageWindowLabel(data.window).toLowerCase()}`}
                value={formatCount(data.totals.requests)}
              />
              <StatTile
                label="Upstream attempts"
                note="Counted separately from requests"
                value={formatCount(data.totals.attempts)}
              />
              <StatTile
                label="Metered spend"
                note="Real money, from a priced model"
                value={formatCost(data.totals.costMetered)}
              />
              {/* Its own tile, not a footnote on the one above: two measures in different
                  currencies of trust, and a reader who sees them stacked adds them. */}
              <StatTile
                label="Notional spend"
                note="Attributed to subscriptions — never added to metered"
                value={formatCost(data.totals.costNotional)}
              />
              <StatTile
                label="Error rate"
                note="Non-success share of attempts"
                value={formatPercent(data.totals.errors, data.totals.attempts)}
              />
              <StatTile
                label="Latency p95"
                note={`p50 ${data.totals.latencyP50Ms} ms`}
                value={`${data.totals.latencyP95Ms} ms`}
              />
              <StatTile
                label="Router overhead p95"
                note="Budgeted under 5 ms — a regression is a bug"
                value={`${data.totals.routerOverheadP95Ms} ms`}
              />
            </section>

            <section aria-label="Requests over time" class={styles.chart}>
              <p class={styles.chartLabel}>
                Requests per {data.bucket} · {usageWindowLabel(data.window)}
              </p>
              <Sparkline
                height={72}
                label={`Requests per ${data.bucket} across the window`}
                points={data.series}
                width={640}
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
    </>
  )
}
