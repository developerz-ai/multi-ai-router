import type { UsageChartPoint } from "./api/usage"

/**
 * Pure geometry for `UsageChart` — requests, attempts and errors plotted on one shared scale.
 *
 * One scale rather than three independent ones, on purpose: a failover chain shows up as
 * attempts drawing away from requests, and that only reads as a shape when both lines share an
 * axis. Three auto-scaled sparklines would each fill their own box and hide exactly that.
 */

export const CHART_VIEW_WIDTH = 100
export const CHART_VIEW_HEIGHT = 40

export const CHART_SERIES_KEYS = ["requests", "attempts", "errors"] as const
export type ChartSeriesKey = (typeof CHART_SERIES_KEYS)[number]

export interface ChartSeries {
  readonly key: ChartSeriesKey
  readonly path: string
}

export function buildChartSeries(points: readonly UsageChartPoint[]): readonly ChartSeries[] {
  if (points.length === 0) return CHART_SERIES_KEYS.map((key) => ({ key, path: "" }))

  const max = Math.max(1, ...points.flatMap((point) => CHART_SERIES_KEYS.map((key) => point[key])))
  const step = points.length === 1 ? 0 : CHART_VIEW_WIDTH / (points.length - 1)

  return CHART_SERIES_KEYS.map((key) => ({
    key,
    path: toPath(
      points.map((point) => point[key]),
      max,
      step,
    ),
  }))
}

function toPath(values: readonly number[], max: number, step: number): string {
  if (values.length === 0) return ""
  if (values.length === 1) {
    const [only] = values
    const y = CHART_VIEW_HEIGHT - ((only ?? 0) / max) * CHART_VIEW_HEIGHT
    return `M0 ${y.toFixed(2)}H${CHART_VIEW_WIDTH}`
  }
  return values
    .map((value, index) => {
      const y = CHART_VIEW_HEIGHT - (value / max) * CHART_VIEW_HEIGHT
      return `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)} ${y.toFixed(2)}`
    })
    .join(" ")
}

export interface ChartTick {
  readonly index: number
  readonly at: string
}

/**
 * First, middle, last — three labels are enough to orient a reader without crowding a chart with
 * one label per bucket, which at a 30-day/day-bucket window would be thirty overlapping strings.
 */
export function pickChartTicks(points: readonly UsageChartPoint[]): readonly ChartTick[] {
  if (points.length === 0) return []
  const last = points.length - 1
  const mid = Math.floor(last / 2)
  const indexes = points.length <= 2 ? [0, last] : [0, mid, last]

  const seen = new Set<number>()
  const ticks: ChartTick[] = []
  for (const index of indexes) {
    if (seen.has(index)) continue
    seen.add(index)
    const point = points[index]
    if (point === undefined) continue
    ticks.push({ index, at: point.at })
  }
  return ticks
}
