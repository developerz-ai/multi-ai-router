import { StatTile } from "../../components/StatTile"
import { type UsageSummary, usageSummaryWindowLabel } from "../../lib/api/usage"
import { formatCost, formatCount, formatMillis, formatPercent } from "../../lib/format"
import styles from "./UsageTiles.module.scss"

/**
 * The headline figures.
 *
 * **Metered and notional spend are shown apart and never summed.** Metered is money someone was
 * billed; notional is spend attributed to a flat-fee subscription, where the invoice does not move
 * when the number does. Adding them produces a figure nobody will ever be charged.
 */
export function UsageTiles(props: { readonly data: UsageSummary }) {
  const totals = () => props.data.totals
  const unpriced = () => totals().unpriced.attempts

  return (
    <section aria-label="Headline figures" class={styles.tiles}>
      <StatTile
        label="Requests"
        note={`Client-facing · ${usageSummaryWindowLabel(props.data.window).toLowerCase()}`}
        value={formatCount(totals().requests)}
      />
      <StatTile
        label="Upstream attempts"
        note="Counted separately from requests"
        value={formatCount(totals().attempts)}
      />
      <StatTile
        label="Metered spend"
        note="Real money, from a priced model"
        value={formatCost(totals().costMetered)}
      />
      {/* Its own tile, not a footnote on the one above: two measures in different currencies of
          trust, and a reader who sees them stacked adds them. */}
      <StatTile
        label="Notional spend"
        note="Attributed to subscriptions — never added to metered"
        value={formatCost(totals().costNotional)}
      />
      {/* Attempts the price table could not price: their spend is in neither figure above. A dash
          when the window predates measurement, never 0 — "0 unpriced" would claim a clean bill
          nobody checked. `StatTile` reads an absent value as "still loading", so the dash is a
          string, not an omission. */}
      <StatTile
        label="Unpriced attempts"
        note={
          unpriced() === null
            ? "Not measured for this window"
            : "No price on file — not in either spend figure"
        }
        value={formatUnpriced(unpriced())}
      />
      {/* One number, and deliberately not the last word on it: the panel below takes it apart
          into the classes an operator can actually act on. */}
      <StatTile
        label="Error rate"
        note="Non-success share of attempts — broken down below"
        value={formatPercent(totals().errors, totals().attempts)}
      />
      {/* `formatMillis` on all four: a null reading renders as an explicitly unread track (`—`),
          never as zero — "0 ms" on the overhead tile is a perfect result nobody measured, the
          exact opposite of "no data in this window". */}
      <StatTile
        label="Latency p95"
        note={`Retained attempts · p50 ${formatMillis(totals().latencyP50Ms)}`}
        value={formatMillis(totals().latencyP95Ms)}
      />
      <StatTile
        label="Router overhead p95"
        note="Retained attempt measurements"
        value={formatMillis(totals().routerOverheadP95Ms)}
      />
      {/* The router's own budget is zero *added* TTFT (CLAUDE.md non-negotiable 8), and this is the
          only figure that can catch a regression there — overhead is measured off the critical
          path, this is on it. */}
      <StatTile
        label="Time to first byte p95"
        note="Retained attempts · includes upstream wait"
        value={formatMillis(totals().ttfbP95Ms)}
      />
    </section>
  )
}

/** A dash for a window nobody measured; `formatCount(null)` does not exist, and 0 would be a claim. */
function formatUnpriced(attempts: number | null): string {
  return attempts === null ? "—" : formatCount(attempts)
}
