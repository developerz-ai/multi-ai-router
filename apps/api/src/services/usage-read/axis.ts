import type { ResolvedWindow, UsageBucket } from "./window"

/**
 * The time axis a series is plotted on.
 *
 * Aggregate queries return only buckets that had traffic, which is correct for a query and wrong
 * for a chart: a quiet hour is a zero, not a missing point, and a sparkline built from sparse rows
 * silently compresses a gap into a line that never dipped. So the axis is computed from the window
 * and the counts are mapped onto it.
 *
 * Every row's sparkline uses this same axis, which is what makes two rows comparable at a glance —
 * the whole reason the breakdown carries one.
 *
 * Pure: a function of the window and the bucket, no clock and no I/O.
 */

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS

/** Guards a `lifetime` window from asking for tens of thousands of points nobody can read. */
const DEFAULT_MAX_POINTS = 400

/** Cover the entire effective range with aligned buckets, including contemporary traffic. */
export function axisBucketWidth(
  window: ResolvedWindow,
  maximumPoints = DEFAULT_MAX_POINTS,
): number {
  if (!Number.isInteger(maximumPoints) || maximumPoints < 2)
    throw new Error("maximumPoints must be at least two")
  const unit = window.bucket === "hour" ? HOUR_MS : DAY_MS
  return Math.max(
    1,
    Math.ceil((window.to.getTime() - window.from.getTime()) / unit / (maximumPoints - 1)),
  )
}

export function buildAxis(
  window: ResolvedWindow,
  bucketWidth = axisBucketWidth(window),
): readonly string[] {
  if (!Number.isInteger(bucketWidth) || bucketWidth < 1)
    throw new Error("bucketWidth must be positive")
  const step = (window.bucket === "hour" ? HOUR_MS : DAY_MS) * bucketWidth
  const start = truncate(window.from, window.bucket, bucketWidth)
  const end = window.to.getTime()

  const points: string[] = []
  for (let at = start; at <= end; at += step) {
    points.push(new Date(at).toISOString())
  }
  // A window shorter than one bucket still gets its bucket, or the chart would be empty for the
  // first hour of every deployment.
  if (points.length === 0) points.push(new Date(start).toISOString())
  return points
}

/**
 * Maps sparse `(bucket, count)` pairs onto the axis, zero-filling the rest.
 *
 * A bucket the query returned that is not on the axis is dropped rather than appended: it means
 * the row predates the window start after truncation, and appending would produce a series longer
 * than the axis every other row uses.
 */
export function densify(
  axis: readonly string[],
  points: ReadonlyMap<string, number>,
): readonly number[] {
  return axis.map((at) => points.get(at) ?? 0)
}

function truncate(from: Date, bucket: UsageBucket, bucketWidth: number): number {
  const time = from.getTime()
  const step = (bucket === "hour" ? HOUR_MS : DAY_MS) * bucketWidth
  return time - (time % step)
}
