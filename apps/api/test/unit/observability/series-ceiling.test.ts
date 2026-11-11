import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createMetrics, type RequestMetricSample } from "../../../src/observability/metrics"
import { createRegistry } from "../../../src/observability/registry"
import { createRuntimeMetrics } from "../../../src/observability/runtime"
import type { ProcessSampler } from "../../../src/observability/self-metrics"
import { createHealthStore, type RoutingCatalog } from "../../../src/services/dataplane"

/**
 * 01.7: the request series were labelled with whatever `model` string a caller typed. 4096 distinct
 * strings filled `router_requests_total`, and from then on a key minted later never appeared in it
 * — dashboards read zero — while the only signal was one `metric stopped adding series` line.
 */

function request(overrides: Partial<RequestMetricSample> = {}): RequestMetricSample {
  return {
    ingressDialect: "anthropic",
    model: "claude-opus-5",
    keyId: "key-1",
    outcome: "success",
    durationMs: 10,
    streamed: false,
    ...overrides,
  }
}

const series = (body: string, name: string) =>
  body.split("\n").filter((line) => line.startsWith(`${name}{`))

describe("router_requests_total under a flood of unknown models", () => {
  test("a key that arrives after 5000 unknown models is still counted", () => {
    const metrics = createMetrics()
    for (let i = 0; i < 5_000; i++) {
      metrics.observeRequest(request({ model: `typo-${i}`, keyId: "noisy", modelKnown: false }))
    }
    metrics.observeRequest(request({ keyId: "key-minted-later", modelKnown: true }))

    const body = metrics.expose()
    expect(body).toContain(
      'router_requests_total{ingress_dialect="anthropic",model="claude-opus-5",key_id="key-minted-later",outcome="success"} 1',
    )
    expect(body).toContain('model="other",key_id="noisy",outcome="success"} 5000')
    expect(body).not.toContain("typo-")
  })

  test("a producer that does not say keeps the verbatim label", () => {
    const metrics = createMetrics()
    metrics.observeRequest(request({ model: "claude-sonnet-5" }))

    expect(metrics.expose()).toContain('model="claude-sonnet-5",key_id="key-1"')
  })
})

describe("router_metric_series_dropped_total", () => {
  test("counts every refused observation, by metric, while the log fires once", () => {
    const limits: string[] = []
    const metrics = createMetrics({
      maxSeriesPerMetric: 2,
      onSeriesLimit: (metric) => limits.push(metric),
    })
    for (const keyId of ["a", "b", "c", "d", "e"]) metrics.observeRequest(request({ keyId }))

    const body = metrics.expose()
    expect(series(body, "router_requests_total")).toHaveLength(2)
    expect(body).toContain('router_metric_series_dropped_total{metric="router_requests_total"} 3')
    expect(limits).toEqual(["router_requests_total"])
  })

  test("the registry reports each refusal, not only the first", () => {
    const dropped: string[] = []
    const registry = createRegistry({
      maxSeriesPerMetric: 1,
      onSeriesDropped: (metric) => dropped.push(metric),
    })
    const c = registry.counter({ name: "spray", help: "h", labels: ["id"] })
    for (const id of ["a", "b", "c"]) c.inc({ id })

    expect(dropped).toEqual(["spray", "spray"])
  })
})

describe("the runtime wiring", () => {
  const EMPTY: RoutingCatalog = { accounts: () => [], pools: () => [] }
  const fixedProcess: ProcessSampler = {
    sample: () => ({
      residentMemoryBytes: 123_456,
      eventLoopDelay: { p50: 0.001, p99: 0.02, max: 0.5 },
    }),
  }
  const runtime = (overrides: { maxSeriesPerMetric?: number } = {}) =>
    createRuntimeMetrics({
      catalog: EMPTY,
      health: createHealthStore(),
      usage: () => ({
        stats: () => ({
          rejectedAfterStop: 0,
          depth: 0,
          dropped: 0,
          written: 0,
          writeFailures: 0,
          writeDiscarded: 0,
        }),
      }),
      logger: createLogger({ level: "error", write: () => {} }),
      processSampler: fixedProcess,
      ...overrides,
    })

  test("takes the ceiling it is given (METRICS_MAX_SERIES_PER_METRIC)", () => {
    const metrics = runtime({ maxSeriesPerMetric: 1 })
    for (const keyId of ["a", "b"]) metrics.observeRequest(request({ keyId }))

    expect(series(metrics.expose(), "router_requests_total")).toHaveLength(1)
  })

  test("exports resident memory and event-loop delay per scrape", () => {
    const body = runtime().expose()

    expect(body).toContain("process_resident_memory_bytes 123456")
    expect(body).toContain('router_event_loop_delay_seconds{quantile="0.99"} 0.02')
    expect(body).toContain('router_event_loop_delay_seconds{quantile="1"} 0.5')
  })
})
