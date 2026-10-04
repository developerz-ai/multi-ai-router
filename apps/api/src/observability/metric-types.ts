import type { ProviderId, QuotaWindowState } from "@multi-ai-router/core"
import type { MetricInventory } from "../config/metric-inventory"
import type { TickResult } from "../scheduler"
import type { RequestSample } from "../services/dataplane"
import type { RoutingSnapshot, SelectionOptions } from "../services/routing"
import type { UsageRecord } from "../services/usage"
import type { RegistryOptions } from "./registry"

export interface AccountMetric {
  readonly id: string
  readonly provider: ProviderId
  /** Health-overlaid, not the stored row: what the router currently believes. */
  readonly status: string
  readonly quotaWindows?: readonly QuotaWindowState[]
  /** The breaker's own `phase()` — `closed`, `open`, `half-open`, or `blocked`. */
  readonly breakerPhase: string
  /** Cooling down because the provider refused the credential (`cooldownReason`). */
  readonly credentialRejected: boolean
}

/** Cumulative admits/refusals off `HealthStore.probeStats()`, read once per scrape. */
export interface ProbeAdmissionSample {
  readonly admitted: number
  readonly refused: number
}

/** postgres.js connections by state — `packages/db/src/pool-metrics.ts` computes the sample. */
export interface DbPoolSample {
  readonly inUse: number
  readonly idle: number
  readonly waiting: number
}

export interface UsageQueueSample {
  readonly depth: number
  /** Cumulative shed count since boot. The delta is what reaches the counter. */
  readonly dropped: number
  /** Cumulative records the writer refused, both tries of a batch that failed twice included. */
  readonly writeFailures: number
  /** Cumulative records lost because their retry was refused too. A subset of the above. */
  readonly writeDiscarded: number
}

/** The subprocess gate's own two numbers, read per scrape — `providers/claude-sdk/concurrency.ts`. */
export interface SdkConcurrencySample {
  readonly inFlight: number
  readonly queued: number
}

export interface RouterMetrics {
  /** One client request, at the point it ended. */
  observeRequest(sample: RequestSample): void
  observeBindingWait(milliseconds: number): void
  /** One upstream attempt. Fed from the usage recorder's drain, off the request path. */
  observeUsage(record: UsageRecord): void
  observeTask(tick: TickResult): void
  /** Replaces the account and quota gauges wholesale. Called per scrape, never per request. */
  setInventory(snapshot: RoutingSnapshot): void
  setAccounts(accounts: readonly AccountMetric[]): void
  setUsageQueue(sample: UsageQueueSample): void
  /**
   * Occupancy of the `claude` subprocess ceiling. Per scrape, from the gate's own counters — a
   * semaphore that reported every acquire would put bookkeeping on the path it is bounding.
   */
  setSdkConcurrency(sample: SdkConcurrencySample): void
  /** Cumulative-to-delta off `HealthStore.probeStats()`, read per scrape like the two above. */
  setProbeAdmissions(sample: ProbeAdmissionSample): void
  /** Per scrape, from the pool wrapper's own in-flight count — see `DbPoolSample`. */
  setDbPool(sample: DbPoolSample): void
  /**
   * When the operator's price overrides were last loaded, from the warm book's own `loadedAt()`.
   * `null` before the first successful load leaves the gauge absent rather than reporting the
   * epoch, which would read as "loaded in 1970" instead of "not loaded yet".
   */
  setPriceOverridesLoadedAt(at: Date | null): void
  /** Registers a per-scrape sampler — see `collectors.ts`. */
  onCollect(collect: () => void): void
  expose(): string
}

export interface MetricsOptions extends RegistryOptions {
  readonly metricInventory?: MetricInventory
  readonly inventorySelectionOptions?: SelectionOptions
  readonly now?: () => Date
  /**
   * The commit `router_build_info{revision}` reports. Defaults to `UNKNOWN_REVISION` so a build
   * nobody stamped says so, rather than inheriting some other build's sha.
   */
  readonly revision?: string
}
