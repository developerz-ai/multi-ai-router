import { describe, expect, test } from "bun:test"
import { createRegistry } from "../../../src/observability/registry"
import { createProcessSampler, createSelfMetrics } from "../../../src/observability/self-metrics"
import { flushSentry } from "../../../src/observability/sentry"

describe("the process sampler", () => {
  test("reads this process's resident memory and the loop's lateness since the last read", async () => {
    const sampler = createProcessSampler()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const sample = sampler.sample()
    expect(sample.residentMemoryBytes).toBeGreaterThan(0)
    expect(sample.eventLoopDelay?.max ?? 0).toBeGreaterThanOrEqual(sample.eventLoopDelay?.p50 ?? 0)
  })
})

describe("router_event_loop_delay_seconds", () => {
  test("an interval with no reading clears the quantiles instead of repeating stale ones", () => {
    const registry = createRegistry()
    const self = createSelfMetrics(registry)
    self.setProcess({ residentMemoryBytes: 1, eventLoopDelay: { p50: 0.1, p99: 0.2, max: 0.3 } })
    self.setProcess({ residentMemoryBytes: 2, eventLoopDelay: null })

    const body = registry.expose()
    expect(body).not.toContain("router_event_loop_delay_seconds{")
    expect(body).toContain("process_resident_memory_bytes 2")
  })

  test("the dropped counter cannot recurse into itself at a ceiling below the metric count", () => {
    let self: ReturnType<typeof createSelfMetrics> | undefined
    const registry = createRegistry({
      maxSeriesPerMetric: 1,
      onSeriesDropped: (metric) => self?.seriesDropped(metric),
    })
    self = createSelfMetrics(registry)
    self.seriesDropped("a")
    self.seriesDropped("b")

    expect(registry.expose()).toContain('router_metric_series_dropped_total{metric="a"} 1')
  })
})

describe("flushSentry", () => {
  test("resolves true at once when no DSN was initialised — nothing to drain", async () => {
    expect(await flushSentry(10)).toBe(true)
  })
})
