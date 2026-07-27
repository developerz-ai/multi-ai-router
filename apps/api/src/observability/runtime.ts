import type { Logger } from "../logging/logger"
import type { SdkConcurrency } from "../providers"
import { type HealthStore, overlayHealth, type RoutingCatalog } from "../services/dataplane"
import type { UsageRecorder } from "../services/usage"
import { createMetrics, type RouterMetrics } from "./metrics"

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
  readonly logger: Logger
  readonly now?: () => Date
  /** Stamped onto `router_build_info{revision}`; `env.revision`, which defaults to `unknown`. */
  readonly revision?: string
}

export function createRuntimeMetrics(deps: RuntimeMetricsDeps): RouterMetrics {
  const metrics = createMetrics({
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.revision === undefined ? {} : { revision: deps.revision }),
    // A metric that hit its ceiling is under-reporting from then on, silently. It is the one
    // thing about this layer worth a log line: the numbers on a dashboard stopped being whole.
    onSeriesLimit: (metric) =>
      deps.logger.warn("metric stopped adding series", { component: "observability", metric }),
  })

  metrics.onCollect(() => {
    metrics.setAccounts(
      deps.catalog.accounts().map((account) => {
        const snapshot = overlayHealth(account.snapshot, deps.health.stateOf(account.id))
        return {
          id: account.id,
          provider: snapshot.provider,
          status: snapshot.status,
          quotaWindows: snapshot.quotaWindows,
        }
      }),
    )

    metrics.setUsageQueue(deps.usage().stats())

    const sdk = deps.sdkConcurrency
    if (sdk !== undefined) {
      metrics.setSdkConcurrency({ inFlight: sdk.inFlight, queued: sdk.queued })
    }
  })

  return metrics
}
