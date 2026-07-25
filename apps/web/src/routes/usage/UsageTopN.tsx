import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { Sparkline } from "../../components/Sparkline"
import type { UsageBreakdownRow, UsageDimension } from "../../lib/api/usage"
import { formatCost, formatCount, formatPercent } from "../../lib/format"
import {
  shareOf,
  TOP_N_MEASURES,
  type TopNMeasure,
  topN,
  topNMeasureLabel,
  topNMeasureValue,
} from "../../lib/usage-index"
import styles from "./UsageTopN.module.scss"

export interface UsageTopNProps {
  readonly rows: readonly UsageBreakdownRow[]
  readonly dimension: UsageDimension
  readonly limit: number
}

/**
 * "Who is at the top", for one measure at a time.
 *
 * The measure is a switch and not four columns because a leaderboard has to be
 * ranked by something, and the only honest ranking is by a single measure the
 * heading names. **Metered and notional spend are two of those measures and are
 * never added into a third.** Metered is billed money; notional is attributed
 * spend on a flat-fee subscription that nobody was charged for. A combined
 * "total cost" ranking would be a number no invoice will ever match, so the
 * caveat under the switcher says so in prose on every measure, not only when a
 * cost is selected.
 *
 * The share bar is never the only carrier of a value: the percentage is written
 * beside it, because a bar is a comparison and an operator still needs the
 * figure.
 */
export function UsageTopN(props: UsageTopNProps) {
  const [measure, setMeasure] = createSignal<TopNMeasure>("requests")
  const headingId = createUniqueId()
  const ranked = createMemo(() => topN(props.rows, measure(), props.limit))

  return (
    <section aria-labelledby={headingId} class={styles.panel}>
      <header class={styles.head}>
        <h2 class={styles.title} id={headingId}>
          Top {dimensionPlural(props.dimension)} by {topNMeasureLabel(measure()).toLowerCase()}
        </h2>
        {/* A real `<fieldset>`, matching the window and dimension switchers: the
            grouping is native, so the `<legend>` names it without an
            `aria-label` that can drift from the visible wording. */}
        <fieldset class={styles.measures}>
          <legend class={styles.groupLabel}>Rank by</legend>
          <For each={TOP_N_MEASURES}>
            {(value) => (
              <button
                aria-pressed={measure() === value ? "true" : "false"}
                class={styles.measure}
                onClick={() => setMeasure(value)}
                type="button"
              >
                {topNMeasureLabel(value)}
              </button>
            )}
          </For>
        </fieldset>
      </header>

      <p class={styles.caveat}>{caveatFor(measure())}</p>

      <Show
        fallback={<p class={styles.empty}>No traffic in this window.</p>}
        when={ranked().length > 0}
      >
        <ol class={styles.rows}>
          <For each={ranked()}>
            {(row, index) => (
              <li class={styles.row}>
                <span class={styles.rank}>{index() + 1}</span>

                <div class={styles.identity}>
                  <span class={styles.label}>{row.label}</span>
                  <Show when={row.note}>{(note) => <span class={styles.note}>{note()}</span>}</Show>
                </div>

                <span class={styles.trend}>
                  <Sparkline
                    label={`Requests over the window for ${row.label}`}
                    points={row.series}
                  />
                </span>

                <span class={styles.value}>{formatMeasure(row, measure())}</span>

                <div class={styles.share}>
                  {/* Decorative: the percentage beside it is the value. */}
                  <span aria-hidden="true" class={styles.track}>
                    <span
                      class={styles.fill}
                      style={{
                        width: `${(shareOf(props.rows, row, measure()) * 100).toFixed(2)}%`,
                      }}
                    />
                  </span>
                  {/* `shareOf` is already numerator ÷ denominator, so a
                      denominator of 1 keeps the console's one spelling of a
                      percentage rather than inventing a second. */}
                  <span class={styles.percent}>
                    {formatPercent(shareOf(props.rows, row, measure()), 1)}
                  </span>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  )
}

/** Counts stay counts and money stays money — one formatter per measure, exhaustively. */
function formatMeasure(row: UsageBreakdownRow, measure: TopNMeasure): string {
  const value = topNMeasureValue(row, measure)
  switch (measure) {
    case "requests":
    case "errors":
      return formatCount(value)
    case "costMetered":
    case "costNotional":
      return formatCost(value)
  }
}

/** The prose that keeps the two costs apart. Visible, always, not a tooltip. */
function caveatFor(measure: TopNMeasure): string {
  switch (measure) {
    case "requests":
      return "Ranked on client-facing requests. Metered and notional spend rank separately and are never added into one figure."
    case "errors":
      return "Ranked on failed requests. Metered and notional spend rank separately and are never added into one figure."
    case "costMetered":
      return "Ranked on metered spend only — real money from a priced model. Notional spend is ranked on its own and is never added to this."
    case "costNotional":
      return "Ranked on notional spend only — attributed spend on a flat-fee subscription: what this traffic would have cost on the API, not money anyone was billed. Never added to metered spend."
  }
}

/** "Top keys", not "Top key" — the heading names a leaderboard, not a row. */
function dimensionPlural(dimension: UsageDimension): string {
  switch (dimension) {
    case "key":
      return "keys"
    case "account":
      return "accounts"
    case "pool":
      return "pools"
    case "model":
      return "models"
  }
}
