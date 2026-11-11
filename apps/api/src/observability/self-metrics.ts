import { monitorEventLoopDelay } from "node:perf_hooks"
import type { Registry } from "./registry"

/**
 * Series about the process itself rather than the traffic through it: how much memory it holds,
 * how late its event loop runs, and how much the registry refused to record.
 *
 * Without the first two a leak or a blocked loop is visible only through cAdvisor, which cannot
 * say *which* replica of a slow request was stalled. The third turns a cardinality ceiling that
 * was hit from one log line at the moment it happened into a rate an alert can be written on.
 */

/** One scrape's reading of the process. Delays in seconds; `null` when nothing was sampled. */
export interface ProcessSample {
  readonly residentMemoryBytes: number
  readonly eventLoopDelay: {
    readonly p50: number
    readonly p99: number
    readonly max: number
  } | null
}

export interface ProcessSampler {
  /** Reads and resets: the delay quantiles describe the interval since the previous scrape. */
  sample(): ProcessSample
}

/**
 * How often the loop is probed for lateness. Not an operator knob: 20 ms resolves the stalls
 * that matter against a 5 ms overhead budget's p99 without the probe itself costing anything.
 */
const EVENT_LOOP_RESOLUTION_MS = 20

const NS_PER_SECOND = 1e9

/**
 * The real process. The delay monitor's timer is unref'd by the runtime, so an enabled monitor
 * never holds a process open that would otherwise exit.
 */
export function createProcessSampler(): ProcessSampler {
  const delay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS })
  delay.enable()
  return {
    sample() {
      const reading =
        delay.count === 0
          ? null
          : {
              p50: delay.percentile(50) / NS_PER_SECOND,
              p99: delay.percentile(99) / NS_PER_SECOND,
              max: delay.max / NS_PER_SECOND,
            }
      delay.reset()
      return { residentMemoryBytes: process.memoryUsage.rss(), eventLoopDelay: reading }
    },
  }
}

const SERIES_DROPPED = "router_metric_series_dropped_total"

export function createSelfMetrics(registry: Registry) {
  const seriesDropped = registry.counter({
    name: SERIES_DROPPED,
    help: "Observations refused because their metric was at METRICS_MAX_SERIES_PER_METRIC. Non-zero means that metric under-reports.",
    labels: ["metric"],
  })
  const residentMemory = registry.gauge({
    name: "process_resident_memory_bytes",
    help: "Resident set size of the router process, bytes.",
    labels: [],
  })
  const fastFallbacks = registry.counter({
    name: "claude_fast_fallback_total",
    help: "Claude subscription requests fast mode handed to the Agent SDK, by reason. A steady count for one reason means an account never takes the fast path.",
    labels: ["reason"],
  })
  const routingCatalogLoadedAt = registry.gauge({
    name: "routing_catalog_loaded_at_seconds",
    help: "Unix time the warm routing catalog last loaded. Falling behind CATALOG_REFRESH_SECONDS means refreshes are failing and routing serves an old snapshot.",
    labels: [],
  })
  const modelCatalogLoadedAt = registry.gauge({
    name: "model_catalog_loaded_at_seconds",
    help: "Unix time the warm model catalog last loaded. Falling behind CATALOG_REFRESH_SECONDS means refreshes are failing.",
    labels: [],
  })
  const loopDelay = registry.gauge({
    name: "router_event_loop_delay_seconds",
    help: "Event-loop lateness since the previous scrape, by quantile (1 is the maximum). A blocked loop delays every request on the replica.",
    labels: ["quantile"],
  })

  return {
    snapshotLoadedAt(store: "routing_catalog" | "model_catalog", at: Date | null): void {
      if (at === null) return
      const gauge = store === "routing_catalog" ? routingCatalogLoadedAt : modelCatalogLoadedAt
      gauge.set({}, at.getTime() / 1_000)
    },
    fastFallback(reason: string): void {
      fastFallbacks.inc({ reason })
    },
    seriesDropped(metric: string): void {
      // Its own refusal would re-enter here without end; one series per metric name never fills
      // a sane ceiling, so the case is only reachable with a ceiling below the metric count.
      if (metric !== SERIES_DROPPED) seriesDropped.inc({ metric })
    },
    setProcess(sample: ProcessSample): void {
      residentMemory.set({}, sample.residentMemoryBytes)
      // Cleared rather than left at the last reading: a scrape interval with no probe sample says
      // nothing about the loop, and a stale p99 would say something false.
      loopDelay.clear()
      const delay = sample.eventLoopDelay
      if (delay === null) return
      loopDelay.set({ quantile: "0.5" }, delay.p50)
      loopDelay.set({ quantile: "0.99" }, delay.p99)
      loopDelay.set({ quantile: "1" }, delay.max)
    },
  }
}
