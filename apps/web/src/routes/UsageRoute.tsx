import { createSignal, For, Show } from "solid-js"
import { Banner } from "../components/Banner"
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
import { formatCost, formatCount, formatPercent } from "../lib/format"
import { useUsageSummary } from "../lib/queries/usage"
import styles from "./UsageRoute.module.scss"
import { UsageBreakdown } from "./usage/UsageBreakdown"

/**
 * The headline surface: any dimension against any window, with the same measures
 * in every cell.
 *
 * Every figure is measured: `GET /api/admin/usage` aggregates the `UsageRecord`
 * rows the router writes off the request path. `placeholder` stays on the shape
 * so the banner can return the moment any part of this screen is ever fed
 * something generated again.
 */
export default function UsageRoute() {
  const [window, setWindow] = createSignal<UsageWindow>("7d")
  const [dimension, setDimension] = createSignal<UsageDimension>("key")
  const summary = useUsageSummary(window)

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
            <Show when={data.placeholder}>
              <Banner title="These figures are placeholder data, not measurements" tone="warn">
                Nothing on this screen came from a request the router served.
              </Banner>
            </Show>

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
                note={`Notional ${formatCost(data.totals.costNotional)}, shown apart`}
                value={formatCost(data.totals.costMetered)}
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

            <UsageBreakdown
              bucket={data.bucket}
              dimension={dimension()}
              rows={breakdownFor(data, dimension())}
            />
          </>
        )}
      </QueryBoundary>
    </>
  )
}
