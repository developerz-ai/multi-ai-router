import { createMemo, mergeProps } from "solid-js"
import styles from "./Sparkline.module.scss"

export interface SparklineProps {
  readonly points: readonly number[]
  /** Announced to assistive tech — the chart itself is decorative. */
  readonly label: string
  readonly width?: number
  readonly height?: number
}

const VIEW_WIDTH = 100
const VIEW_HEIGHT = 24

/**
 * Trend at a glance, inside a table cell. Deliberately not a chart library:
 * there are no axes, no ticks, no tooltip — the row's own numeric columns carry
 * the values, and this only answers "rising, falling, or flat".
 *
 * `currentColor` throughout, so a sparkline inherits whatever the cell's tone
 * already is and never introduces a colour of its own.
 */
export function Sparkline(props: SparklineProps) {
  const merged = mergeProps({ width: 80, height: 20 }, props)

  const path = createMemo(() => toPath(merged.points))

  return (
    <svg
      aria-label={merged.label}
      class={styles.chart}
      height={merged.height}
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      width={merged.width}
    >
      <path class={styles.line} d={path()} />
    </svg>
  )
}

/**
 * Pure. A flat series is drawn along the vertical middle rather than the floor:
 * a constant thousand requests an hour is not the same picture as zero, and
 * pinning it to the bottom says it is.
 */
function toPath(points: readonly number[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M0 ${VIEW_HEIGHT / 2}H${VIEW_WIDTH}`

  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min
  const step = VIEW_WIDTH / (points.length - 1)

  return points
    .map((value, index) => {
      const ratio = span === 0 ? 0.5 : (value - min) / span
      const y = VIEW_HEIGHT - ratio * VIEW_HEIGHT
      return `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)} ${y.toFixed(2)}`
    })
    .join(" ")
}
