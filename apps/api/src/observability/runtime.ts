import type { MetricInventory } from "../config/metric-inventory"
import type { Logger } from "../logging/logger"
import type { SdkConcurrency } from "../providers"
import type { PriceBook } from "../services/cost"
import {
  buildSnapshot,
  type HealthStore,
  overlayHealth,
  type RoutingCatalog,
} from "../services/dataplane"
import { phase, type SelectionOptions } from "../services/routing"
import type { UsageRecorder } from "../services/usage"
import { createMetrics, type DbPoolSample, type RouterMetrics } from "./metrics"
import { createProcessSampler, type ProcessSampler } from "./self-metrics"

/**
 * The router's metrics as the running process wires them: the registry, plus the gauges that
 * describe *state* rather than events and are therefore sampled once per scrape.
 *
 * Account status, quota utilization, usage-queue depth and the `claude` subprocess gate's occupancy
 * are all already held in warm memory for the request path. Mirroring every change into a gauge as
 * it happened would put bookkeeping on that path for a number nobody reads until Prometheus asks;
 * reading the same warm state when it does ask costs one pass over the account list, on the
 * scrape's own thread of control.
 *
 * The snapshot is read through `overlayHealth`, the same function the routing snapshot is built
 * with, so `router_accounts{status="cooling_down"}` cannot disagree with the router about which
 * accounts are cooling down.
 */

export interface RuntimeMetricsDeps {
  readonly metricInventory?: MetricInventory
  readonly inventorySelectionOptions?: SelectionOptions
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  /**
   * Read per scrape, and a getter rather than the recorder itself: the recorder feeds
   * `observeUsage` from its drain, so it is constructed *after* the metrics it reports into.
   */
  readonly usage: () => Pick<UsageRecorder, "stats">
  /**
   * The replica's `claude` subprocess gate. Optional so a build with no SDK wiring still exports
   * every other series — the two gauges are simply absent, which is honest, rather than reporting a
   * ceiling of zero that nothing is holding.
   */
  readonly sdkConcurrency?: Pick<SdkConcurrency, "inFlight" | "queued">
  /**
   * The warm override book, for its load timestamp. Optional so a build without a database-backed
   * book still exports every other series: the gauge is absent, which says "no overrides here"
   * rather than claiming a load that never happened.
   */
  readonly prices?: Pick<PriceBook, "loadedAt">
  /** The warm routing and model catalogs, for their `*_loaded_at_seconds` gauges. */
  readonly snapshots?: {
    readonly routingCatalog: { loadedAt(): Date | null }
    readonly modelCatalog: { loadedAt(): Date | null }
  }
  /**
   * The pool wrapper's own sample (`packages/db/src/pool-metrics.ts`). Optional for the same reason
   * as `sdkConcurrency`: a build wired against a stub `Database` in a test still exports every other
   * series, with this one simply absent rather than claiming a pool that was never measured.
   */
  readonly dbPool?: { sample(): DbPoolSample }
  readonly logger: Logger
  /** `METRICS_MAX_SERIES_PER_METRIC`. Defaults to the registry's own ceiling. */
  readonly maxSeriesPerMetric?: number
  /** Resident memory and event-loop delay, per scrape. Defaults to this process. */
  readonly processSampler?: ProcessSampler
  readonly now?: () => Date
  /** Stamped onto `router_build_info{revision}`; `env.revision`, which defaults to `unknown`. */
  readonly revision?: string
}

export function createRuntimeMetrics(deps: RuntimeMetricsDeps): RouterMetrics {
  const metrics = createMetrics({
    ...(deps.inventorySelectionOptions === undefined
      ? {}
      : { inventorySelectionOptions: deps.inventorySelectionOptions }),
    ...(deps.metricInventory === undefined ? {} : { metricInventory: deps.metricInventory }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.revision === undefined ? {} : { revision: deps.revision }),
    ...(deps.maxSeriesPerMetric === undefined
      ? {}
      : { maxSeriesPerMetric: deps.maxSeriesPerMetric }),
    // A metric that hit its ceiling under-reports from then on. The first refusal gets a log line
    // that names it; every refusal counts on `router_metric_series_dropped_total`.
    onSeriesLimit: (metric) =>
      deps.logger.warn("metric stopped adding series", { component: "observability", metric }),
  })

  const at = deps.now ?? (() => new Date())
  const processSampler = deps.processSampler ?? createProcessSampler()

  metrics.onCollect(() => {
    const now = at()
    metrics.setInventory(
      buildSnapshot(deps.catalog, { stateOf: (id) => deps.health.stateOf(id) }, now),
    )
    metrics.setAccounts(
      deps.catalog.accounts().map((account) => {
        const state = deps.health.stateOf(account.id)
        const snapshot = overlayHealth(account.snapshot, state)
        return {
          id: account.id,
          provider: snapshot.provider,
          status: snapshot.status,
          quotaWindows: snapshot.quotaWindows,
          breakerPhase: phase(state.breaker, now),
          credentialRejected:
            snapshot.status === "cooling_down" &&
            snapshot.health.cooldownReason === "credential-rejected",
        }
      }),
    )

    metrics.setUsageQueue(deps.usage().stats())
    metrics.setProbeAdmissions(deps.health.probeStats())

    const sdk = deps.sdkConcurrency
    if (sdk !== undefined) {
      metrics.setSdkConcurrency({ inFlight: sdk.inFlight, queued: sdk.queued })
    }

    metrics.setProcess(processSampler.sample())

    if (deps.dbPool !== undefined) metrics.setDbPool(deps.dbPool.sample())

    if (deps.prices !== undefined) metrics.setPriceOverridesLoadedAt(deps.prices.loadedAt())
    if (deps.snapshots !== undefined) {
      metrics.setSnapshotLoadedAt("routing_catalog", deps.snapshots.routingCatalog.loadedAt())
      metrics.setSnapshotLoadedAt("model_catalog", deps.snapshots.modelCatalog.loadedAt())
    }
  })

  return metrics
}
