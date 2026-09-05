import { createMemo, For, Show } from "solid-js"
import type { UsageChartPoint } from "../../lib/api/usage"
import { formatDate, formatTime } from "../../lib/format"
import {
  buildChartSeries,
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  pickChartTicks,
} from "../../lib/usage-chart"
import styles from "./UsageChart.module.scss"

export interface UsageChartProps {
  readonly points: readonly UsageChartPoint[]
  readonly bucket: "hour" | "day"
}

const LEGEND = [
  { key: "requests", label: "Requests" },
  { key: "attempts", label: "Attempts" },
  { key: "errors", label: "Errors" },
] as const

/**
 * Requests, attempts and errors, plotted together against the window's own axis.
 *
 * Replaces a bare request-count sparkline: `axis`, each bucket's `at`, and the per-bucket
 * `attempts`/`errors` the wire already carries were being read off the response and then thrown
 * away before this existed, leaving requests as the only line a reader could see. Attempts
 * diverging from requests *is* a failover chain running; errors climbing while requests hold
 * steady is a bad window — neither shape is visible in a single-series chart.
 */
export function UsageChart(props: UsageChartProps) {
  const series = createMemo(() => buildChartSeries(props.points))
  const ticks = createMemo(() => pickChartTicks(props.points))
  const formatTick = (at: string) => (props.bucket === "hour" ? formatTime(at) : formatDate(at))
  // Three flat lines on the baseline read as a broken chart, not as zero traffic. Say which it is.
  const silent = createMemo(() =>
    props.points.every(
      (point) => point.requests === 0 && point.attempts === 0 && point.errors === 0,
    ),
  )

  return (
    <div class={styles.root}>
      <Show when={silent()}>
        <p class={styles.empty}>No traffic in this window — the lines would all sit on zero.</p>
      </Show>
      <svg
        aria-label={`Requests, attempts and errors per ${props.bucket} across the window`}
        class={styles.chart}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}
      >
        <For each={series()}>{(one) => <path class={styles[one.key]} d={one.path} />}</For>
      </svg>

      <Show when={ticks().length > 0}>
        <div class={styles.axis}>
          <For each={ticks()}>
            {(tick) => <span class={styles.tick}>{formatTick(tick.at)}</span>}
          </For>
        </div>
      </Show>

      <ul class={styles.legend}>
        <For each={LEGEND}>
          {(entry) => (
            <li class={styles.legendItem}>
              <span aria-hidden="true" class={styles.swatch} data-series={entry.key} />
              {entry.label}
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
