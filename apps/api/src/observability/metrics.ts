import { setAccountMetrics } from "./account-metrics"
import type { MetricsOptions, RouterMetrics } from "./metric-types"

export type {
  AccountMetric,
  DbPoolSample,
  MetricsOptions,
  ProbeAdmissionSample,
  RequestMetricSample,
  RouterMetrics,
  SdkConcurrencySample,
  UsageQueueSample,
} from "./metric-types"

import type { EgressMode, ProviderId } from "@multi-ai-router/core"
import { UNKNOWN_REVISION, USAGE_OUTCOME_SUCCESS, VERSION } from "@multi-ai-router/core"
import { PRICE_TABLE_AS_OF } from "../services/cost"
import type { UsageRecord } from "../services/usage"
import { createFailoverTracker } from "./failovers"
import { createInventoryMetrics } from "./inventory"
import { createSelfMetrics } from "./self-metrics"
import { createSeries } from "./series"

/**
 * The router's metrics, expressed as a mapping from things that already happen onto the series in
 * `series.ts`. Nothing here measures anything: every number arrives from a `UsageRecord`, a
 * dispatch that finished, a scheduler tick, or a snapshot read once per scrape.
 *
 * That is the point. Attempt-level series are fed from the usage recorder's **background drain**,
 * not from the dispatch loop, so a metric write can never sit between a client and its first
 * token (CLAUDE.md non-negotiable 8). The two client-request series are fed once per request, at
 * the single place a request is known to have ended, because no attempt row can name which
 * attempt the client's answer came from.
 *
 * `router_failovers_total` is exact; `failovers.ts` holds the one piece of state that costs.
 */

/**
 * Ceiling on label text taken from a request body. Not an operator knob: a model name is a
 * client-supplied string, and an unbounded one would put a kilobyte into an exposition line.
 */
const MAX_LABEL_CHARS = 64

const UNKNOWN = "unknown"

/**
 * The `model` label for a requested name the routing catalog did not resolve. Every caller with a
 * key can type any string; labelling it verbatim let a typo loop fill the series ceiling and lock
 * every later key and model out of the request series until restart.
 */
const OTHER_MODEL = "other"

/** `path` on `router_overhead_seconds`, as the spec spells it. */
const EGRESS_PATH: Readonly<Record<EgressMode, string>> = {
  passthrough: "passthrough",
  translate: "translate",
  "agent-sdk": "agent_sdk",
}

export function createMetrics(options: MetricsOptions = {}): RouterMetrics {
  const now = options.now ?? (() => new Date())
  // Late-bound: the dropped counter lives in the registry whose refusals it counts.
  let countDropped: (metric: string) => void = () => {}
  const s = createSeries({
    ...options,
    onSeriesDropped: (metric) => {
      countDropped(metric)
      options.onSeriesDropped?.(metric)
    },
  })
  const inventory = createInventoryMetrics(
    s.registry,
    options.metricInventory ?? {},
    options.inventorySelectionOptions,
  )
  const bindingWait = s.registry.histogram({
    name: "router_session_binding_wait_seconds",
    help: "Elapsed awaited session binding reads, including database pool queue, query and promise wait.",
    labels: [],
    buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  })
  const usageAdmission = s.registry.histogram({
    name: "router_usage_admission_seconds",
    help: "Awaited usage admission duration including database lock, transaction and promise wait.",
    labels: [],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15],
  })
  const self = createSelfMetrics(s.registry)
  countDropped = self.seriesDropped
  const settleFailover = createFailoverTracker((hop) => s.failovers.inc(hop))
  const consecutiveFailures = new Map<string, number>()
  let droppedSeen = 0
  let retriedSeen = 0
  let discardedSeen = 0
  let probeAdmittedSeen = 0
  let probeRefusedSeen = 0

  // Set once, here, rather than from a per-scrape collector: neither label can change while the
  // process runs, and `setAccounts` clears only the gauges it rebuilds, so this one survives.
  s.buildInfo.set({ version: VERSION, revision: options.revision ?? UNKNOWN_REVISION }, 1)
  // Likewise fixed for the life of the process: the shipped table's date is compiled into the
  // image. A parse that fails leaves the gauge absent, which reads as "undatable" rather than as
  // an epoch timestamp claiming the table was verified in 1970.
  const asOf = Date.parse(`${PRICE_TABLE_AS_OF}T00:00:00Z`)
  if (Number.isFinite(asOf)) s.priceTableAsOf.set({}, asOf / 1_000)

  const observeTokens = (record: UsageRecord, provider: ProviderId, accountId: string): void => {
    const model = label(record.model ?? "unknown")
    const directions = [
      ["input", record.tokensIn],
      ["output", record.tokensOut],
      ["cache_read", record.cacheReadTokens],
      ["cache_creation", record.cacheWriteTokens],
    ] as const
    for (const [direction, count] of directions) {
      if (count <= 0) continue
      s.tokens.inc({ provider, account_id: accountId, model, direction }, count)
    }
  }

  return {
    setInventory: inventory.collect,
    observeBindingWait(milliseconds) {
      if (Number.isFinite(milliseconds) && milliseconds >= 0)
        bindingWait.observe({}, milliseconds / 1_000)
    },
    observeUsageAdmission(milliseconds) {
      if (Number.isFinite(milliseconds) && milliseconds >= 0)
        usageAdmission.observe({}, milliseconds / 1_000)
    },
    observeRequest(sample) {
      inventory.observe(sample)
      const ingress_dialect = sample.ingressDialect
      // Unset means the producer predates the flag: label as before rather than fold every model.
      const model = sample.modelKnown === false ? OTHER_MODEL : label(sample.model ?? UNKNOWN)
      s.requests.inc({ ingress_dialect, model, key_id: sample.keyId, outcome: sample.outcome })
      s.requestDuration.observe(
        { ingress_dialect, model, streamed: String(sample.streamed) },
        sample.durationMs / 1_000,
      )
    },

    observeUsage(record) {
      // A preflight rejection reached no upstream and took no egress path: it has no provider to
      // attribute time to, and inventing one would put router-only failures on a provider's row.
      if (record.ingressDialect !== null && record.egressMode !== null) {
        s.overhead.observe(
          { ingress_dialect: record.ingressDialect, path: EGRESS_PATH[record.egressMode] },
          record.routerOverheadMs / 1_000,
        )
      }
      settleFailover(record)

      const provider = record.provider
      const account_id = record.accountId
      if (provider === null || account_id === null) return

      s.upstreamAttempts.inc({ provider, account_id, outcome: record.outcome })
      s.upstreamDuration.observe(
        { provider, account_id, streamed: String(record.streamed) },
        record.latencyMs / 1_000,
      )
      observeTokens(record, provider, account_id)
      // Every attempt that reached an account, priced or not — the ratio is the point, and a
      // counter that only moved for the priced ones would report 100% coverage of whatever it
      // happened to cover. The attempts excluded by the early return above never chose a provider,
      // so they have no row in any cost column to be missing from.
      //
      // Labelled with the **requested** model, not the upstream one: an operator reading this to
      // decide what to price next needs the name their clients ask for.
      s.costBasis.inc({
        provider,
        model: label(record.model ?? "unknown"),
        basis: record.costBasis,
      })
      if (record.outcome !== USAGE_OUTCOME_SUCCESS) {
        s.upstreamErrors.inc({
          provider,
          account_id,
          // NULL means the upstream was never reached, which is a different failure from one it
          // answered with — the label keeps the two apart rather than folding both into `0`.
          status: record.httpStatus === null ? "none" : String(record.httpStatus),
          error_class: record.errorClass ?? record.outcome,
        })
      }
    },

    observeTask(tick) {
      const task = tick.task
      s.taskRuns.inc({ task, outcome: tick.status })
      // Remote contention or local capacity did not run: it has no duration, processed nothing,
      // and must not reset the failure streak the replica that *is* running has accumulated.
      if (tick.status === "skipped_locked" || tick.status === "skipped_capacity") return

      s.taskDuration.observe({ task }, tick.durationMs / 1_000)
      s.taskItems.inc({ task }, tick.itemsProcessed)
      if (tick.status === "failed") {
        const failures = (consecutiveFailures.get(task) ?? 0) + 1
        consecutiveFailures.set(task, failures)
        s.taskConsecutiveFailures.set({ task }, failures)
        return
      }
      // `partial` hit its batch limit with more to do — a bounded run that worked, not a failure.
      consecutiveFailures.set(task, 0)
      s.taskConsecutiveFailures.set({ task }, 0)
      s.taskLastSuccess.set({ task }, now().getTime() / 1_000)
    },

    setAccounts: (accounts) => setAccountMetrics(s, accounts, now),

    setUsageQueue(sample) {
      s.usageQueueDepth.set({}, sample.depth)
      droppedSeen = advance(droppedSeen, sample.dropped, (delta) =>
        s.usageRecordsDropped.inc({}, delta),
      )
      // Every refused record is one or the other, so the two dispositions sum to the failures the
      // recorder counted. `retried` is the remainder rather than a number of its own: the recorder
      // learns a batch was lost one flush *after* it learns the write failed.
      retriedSeen = advance(retriedSeen, sample.writeFailures - sample.writeDiscarded, (delta) =>
        s.usageWriteFailures.inc({ disposition: "retried" }, delta),
      )
      discardedSeen = advance(discardedSeen, sample.writeDiscarded, (delta) =>
        s.usageWriteFailures.inc({ disposition: "discarded" }, delta),
      )
    },

    setPriceOverridesLoadedAt(at) {
      if (at !== null) s.priceOverridesLoadedAt.set({}, at.getTime() / 1_000)
    },

    setSdkConcurrency(sample) {
      s.sdkSubprocesses.set({}, sample.inFlight)
      s.sdkSubprocessQueueDepth.set({}, sample.queued)
    },

    setProbeAdmissions(sample) {
      probeAdmittedSeen = advance(probeAdmittedSeen, sample.admitted, (delta) =>
        s.breakerProbeAdmissions.inc({ result: "admitted" }, delta),
      )
      probeRefusedSeen = advance(probeRefusedSeen, sample.refused, (delta) =>
        s.breakerProbeAdmissions.inc({ result: "refused" }, delta),
      )
    },

    setProcess: (sample) => self.setProcess(sample),
    observeFastFallback: (reason) => self.fastFallback(reason),
    setSnapshotLoadedAt: (store, at) => self.snapshotLoadedAt(store, at),

    setDbPool(sample) {
      s.dbPoolConnections.set({ state: "in_use" }, sample.inUse)
      s.dbPoolConnections.set({ state: "idle" }, sample.idle)
      s.dbPoolConnections.set({ state: "waiting" }, sample.waiting)
    },

    onCollect: (collect) => s.registry.onCollect(collect),
    expose: () => s.registry.expose(),
  }
}

/**
 * Cumulative-to-delta. The recorder counts running totals; a counter takes increments. Returns the
 * new watermark, and adds nothing when the total went backwards — which it does the moment a
 * process restarts, and a counter that fell would be read as a negative rate.
 */
function advance(seen: number, total: number, add: (delta: number) => void): number {
  if (total <= seen) return seen
  add(total - seen)
  return total
}

/** Client-supplied text, bounded. Empty reads as unknown so a series is never label-less. */
function label(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return UNKNOWN
  return trimmed.length <= MAX_LABEL_CHARS ? trimmed : trimmed.slice(0, MAX_LABEL_CHARS)
}
