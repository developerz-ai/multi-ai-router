import { describe, expect, test } from "bun:test"
import {
  type HistogramSeries,
  histogramMean,
  histogramQuantile,
  parseHistogram,
  sampleQuantile,
} from "../../../bench/quantiles"

/**
 * The bench reads its verdict out of the router's own exposition, so the parser and the quantile
 * math are the two places a passing benchmark could be wrong on purpose. Pure functions, text in,
 * numbers out — no app, no clock, no metrics registry.
 */

const EXPOSITION = `# HELP router_overhead_seconds Time spent inside the router, excluding upstream.
# TYPE router_overhead_seconds histogram
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="0.0005"} 60
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="0.001"} 90
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="0.005"} 100
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="+Inf"} 100
router_overhead_seconds_sum{ingress_dialect="anthropic",path="passthrough"} 0.05
router_overhead_seconds_count{ingress_dialect="anthropic",path="passthrough"} 100
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="translate",le="0.0005"} 0
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="translate",le="0.001"} 4
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="translate",le="0.005"} 10
router_overhead_seconds_bucket{ingress_dialect="anthropic",path="translate",le="+Inf"} 10
router_overhead_seconds_sum{ingress_dialect="anthropic",path="translate"} 0.02
router_overhead_seconds_count{ingress_dialect="anthropic",path="translate"} 10
# HELP router_usage_queue_depth Usage records awaiting batch write.
# TYPE router_usage_queue_depth gauge
router_usage_queue_depth 0
`

function seriesFor(path: string): HistogramSeries {
  const found = parseHistogram(EXPOSITION, "router_overhead_seconds").find(
    (series) => series.labels.path === path,
  )
  if (found === undefined) throw new Error(`no series for ${path}`)
  return found
}

describe("parseHistogram", () => {
  test("splits one family into a series per label set, dropping le from the identity", () => {
    const series = parseHistogram(EXPOSITION, "router_overhead_seconds")

    expect(series).toHaveLength(2)
    expect(series[0]?.labels).toEqual({ ingress_dialect: "anthropic", path: "passthrough" })
    expect(series[0]?.labels.le).toBeUndefined()
  })

  test("reads sum and count off their own lines, not off the buckets", () => {
    expect(seriesFor("passthrough").sum).toBe(0.05)
    expect(seriesFor("passthrough").count).toBe(100)
  })

  test("parses +Inf as an infinity and keeps the buckets ascending", () => {
    const buckets = seriesFor("passthrough").buckets

    expect(buckets.map((bucket) => bucket.le)).toEqual([
      0.0005,
      0.001,
      0.005,
      Number.POSITIVE_INFINITY,
    ])
    expect(buckets.map((bucket) => bucket.count)).toEqual([60, 90, 100, 100])
  })

  test("ignores every other family, including a gauge with no labels at all", () => {
    expect(parseHistogram(EXPOSITION, "router_usage_queue_depth")).toEqual([])
    expect(parseHistogram(EXPOSITION, "router_request_duration_seconds")).toEqual([])
  })

  test("does not confuse a metric with one whose name it prefixes", () => {
    const shared = `router_overhead_seconds_extra_bucket{le="1"} 5
router_overhead_seconds_extra_count 5
`
    expect(parseHistogram(shared, "router_overhead_seconds")).toEqual([])
  })
})

describe("histogramQuantile", () => {
  test("interpolates inside the bucket the rank lands in, from a lower bound of zero", () => {
    // p50 of 100 samples is rank 50, inside the first bucket: 0 -> 0.0005 across 60 observations.
    expect(histogramQuantile(seriesFor("passthrough"), 0.5)).toBeCloseTo((50 / 60) * 0.0005, 9)
  })

  test("interpolates from the previous bound once the rank leaves the first bucket", () => {
    // p95 is rank 95, inside 0.001 -> 0.005, which holds the 10 observations above 90.
    expect(histogramQuantile(seriesFor("passthrough"), 0.95)).toBeCloseTo(
      0.001 + (5 / 10) * 0.004,
      9,
    )
  })

  test("reports the highest finite bound when the rank lands in +Inf, as Prometheus does", () => {
    const overflowing: HistogramSeries = {
      labels: {},
      buckets: [
        { le: 0.001, count: 1 },
        { le: 0.005, count: 1 },
        { le: Number.POSITIVE_INFINITY, count: 10 },
      ],
      sum: 9,
      count: 10,
    }
    expect(histogramQuantile(overflowing, 0.99)).toBe(0.005)
  })

  test("is NaN for a series nothing was ever observed into — never zero", () => {
    const empty: HistogramSeries = { labels: {}, buckets: [], sum: 0, count: 0 }

    expect(histogramQuantile(empty, 0.99)).toBeNaN()
    expect(histogramMean(empty)).toBeNaN()
  })

  test("mean divides the accumulated sum by the count", () => {
    expect(histogramMean(seriesFor("passthrough"))).toBeCloseTo(0.0005, 9)
  })
})

describe("sampleQuantile", () => {
  test("interpolates between the two samples the rank falls between", () => {
    expect(sampleQuantile([0, 10], 0.5)).toBe(5)
    expect(sampleQuantile([0, 1, 2, 3, 4], 0.5)).toBe(2)
  })

  test("returns the extremes at 0 and 1", () => {
    expect(sampleQuantile([1, 2, 9], 0)).toBe(1)
    expect(sampleQuantile([1, 2, 9], 1)).toBe(9)
  })

  test("is NaN with no samples, so an unexercised path never reads as a fast one", () => {
    expect(sampleQuantile([], 0.99)).toBeNaN()
  })
})
