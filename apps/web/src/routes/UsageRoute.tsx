import { createSignal, For, Show } from "solid-js"
import { Button } from "../components/Button"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { StatTile } from "../components/StatTile"
import { TableSkeleton } from "../components/TableSkeleton"
import {
  breakdownFor,
  isCustomRange,
  USAGE_DIMENSIONS,
  USAGE_WINDOWS,
  type UsageDimension,
  type UsageRange,
  type UsageWindow,
  usageDimensionLabel,
  usageSummaryWindowLabel,
  usageWindowLabel,
} from "../lib/api/usage"
import { createNow } from "../lib/clock"
import { fromDateTimeInput } from "../lib/datetime-input"
import { formatCost, formatCount, formatMillis, formatPercent } from "../lib/format"
import { useAllAccounts } from "../lib/queries/accounts"
import { useUsageSummary } from "../lib/queries/usage"
import styles from "./UsageRoute.module.scss"
import { UsageBreakdown } from "./usage/UsageBreakdown"
import { UsageChart } from "./usage/UsageChart"
import { UsageFailures } from "./usage/UsageFailures"
import { UsageQuota } from "./usage/UsageQuota"
import { UsageRecent } from "./usage/UsageRecent"
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
 *
 * The live feed at the foot of the screen is the one panel here that is not an
 * aggregate. It answers *which* request failed rather than how many did, and it
 * sits outside the summary's `QueryBoundary` so a failing rollup cannot take the
 * diagnosis down with it.
 */
export default function UsageRoute() {
  const now = createNow(30_000)
  const [range, setRange] = createSignal<UsageRange>("7d")
  const [dimension, setDimension] = createSignal<UsageDimension>("key")
  const [customFrom, setCustomFrom] = createSignal("")
  const [customTo, setCustomTo] = createSignal("")
  const [customError, setCustomError] = createSignal<string | null>(null)
  const summary = useUsageSummary(range)
  const accounts = useAllAccounts()

  function selectWindow(value: UsageWindow) {
    setCustomError(null)
    setRange(value)
  }

  // A custom range is its own explicit action, not a side effect of typing: nothing is sent
  // until Apply is pressed, so a half-edited `from` never fires a request for a nonsense window.
  function applyCustomRange(event: SubmitEvent) {
    event.preventDefault()
    const from = fromDateTimeInput(customFrom())
    const to = fromDateTimeInput(customTo())
    if (from === null || to === null) {
      setCustomError("Both from and to are required.")
      return
    }
    if (Date.parse(from) >= Date.parse(to)) {
      setCustomError("From must be before to.")
      return
    }
    setCustomError(null)
    setRange({ from, to })
  }

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
                  aria-pressed={!isCustomRange(range()) && range() === value ? "true" : "false"}
                  class={styles.window}
                  onClick={() => selectWindow(value)}
                  type="button"
                >
                  {usageWindowLabel(value)}
                </button>
              )}
            </For>
          </fieldset>
        }
        subtitle="Who burned what — and, in the live feed below, which request failed and why."
        title="Usage"
      />

      {/* A custom range is the fifth window CLAUDE.md asks for, not a special case: the server
          has taken `from`/`to` since `services/usage-read/window.ts` was written, and this is the
          one place in the console that was never wired to ask for it. Overview's own window
          picker (`OverviewRoute`) is named-window only — a custom range is answered here. */}
      <form class={styles.customRange} onSubmit={applyCustomRange}>
        <span class={styles.customCaption}>Custom range</span>
        <label class={styles.customField}>
          From
          <input
            class={styles.customInput}
            onInput={(event) => setCustomFrom(event.currentTarget.value)}
            type="datetime-local"
            value={customFrom()}
          />
        </label>
        <label class={styles.customField}>
          To
          <input
            class={styles.customInput}
            onInput={(event) => setCustomTo(event.currentTarget.value)}
            type="datetime-local"
            value={customTo()}
          />
        </label>
        <Button size="sm" tone="neutral" type="submit">
          Apply
        </Button>
        <Show when={isCustomRange(range())}>
          <span class={styles.customActive}>Showing a custom range</span>
        </Show>
        <Show when={customError()}>
          {(message) => <span class={styles.customErr}>{message()}</span>}
        </Show>
      </form>

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
                note={`Client-facing · ${usageSummaryWindowLabel(data.window).toLowerCase()}`}
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
              {/* One number, and deliberately not the last word on it: the panel below takes it
                  apart into the classes an operator can actually act on. */}
              <StatTile
                label="Error rate"
                note="Non-success share of attempts — broken down below"
                value={formatPercent(data.totals.errors, data.totals.attempts)}
              />
              {/* `formatMillis` on all four: a null reading renders as an explicitly unread
                  track (`—`), never as zero — "0 ms" on the overhead tile is a perfect result
                  nobody measured, the exact opposite of "no data in this window". */}
              <StatTile
                label="Latency p95"
                note={`p50 ${formatMillis(data.totals.latencyP50Ms)}`}
                value={formatMillis(data.totals.latencyP95Ms)}
              />
              <StatTile
                label="Router overhead p95"
                note="Budgeted under 5 ms — a regression is a bug"
                value={formatMillis(data.totals.routerOverheadP95Ms)}
              />
              {/* Fetched and rendered nowhere before this: the router's own budget is zero *added*
                  TTFT (CLAUDE.md non-negotiable 8), and this is the only figure that can catch a
                  regression there — overhead is measured off the critical path, this is on it. */}
              <StatTile
                label="Time to first byte p95"
                note="Budgeted at zero added TTFT"
                value={formatMillis(data.totals.ttfbP95Ms)}
              />
            </section>

            {/* Directly under the tiles, above the charts: the error-rate tile is the figure an
                operator stops on, and this is the sentence that follows it. */}
            <UsageFailures
              failures={data.failures}
              windowLabel={usageSummaryWindowLabel(data.window)}
            />

            <section aria-label="Requests, attempts and errors over time" class={styles.chart}>
              <p class={styles.chartLabel}>
                Requests, attempts and errors per {data.bucket} ·{" "}
                {usageSummaryWindowLabel(data.window)}
              </p>
              <UsageChart bucket={data.bucket} points={data.series} />
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

      {/* Outside the summary's boundary on purpose. The feed is what an operator
          opens when something is broken, and gating it on the aggregate would
          mean a failing rollup takes the diagnosis down with it. Its own query,
          its own window, its own error state. */}
      <UsageRecent />
    </>
  )
}
