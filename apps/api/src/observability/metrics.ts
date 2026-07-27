import type { EgressMode, ProviderId, QuotaWindowState, UsageOutcome } from "@multi-ai-router/core"
import {
  AccountStatus,
  UNKNOWN_REVISION,
  USAGE_OUTCOME_SUCCESS,
  VERSION,
} from "@multi-ai-router/core"
import type { TickResult } from "../scheduler"
import { PRICE_TABLE_AS_OF } from "../services/cost"
import type { RequestSample } from "../services/dataplane"
import type { UsageRecord } from "../services/usage"
import type { RegistryOptions } from "./registry"
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
 * `router_failovers_total` is exact rather than estimated, and that costs the one piece of state
 * in this file: a failed attempt is only counted as a failover once a *later* attempt of the same
 * request proves the router moved on. A chain that gave up leaves its last failure uncounted,
 * which is correct — it moved nowhere.
 */

export interface AccountMetric {
  readonly id: string
  readonly provider: ProviderId
  /** Health-overlaid, not the stored row: what the router currently believes. */
  readonly status: string
  readonly quotaWindows?: readonly QuotaWindowState[]
  /** The breaker's own `phase()` — `closed`, `open`, `half-open`, or `blocked`. */
  readonly breakerPhase: string
}

/** Every value `phase()` can return, so the gauge can zero the ones an account is not in. */
const BREAKER_PHASES = ["closed", "open", "half-open", "blocked"] as const

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
  /** One upstream attempt. Fed from the usage recorder's drain, off the request path. */
  observeUsage(record: UsageRecord): void
  observeTask(tick: TickResult): void
  /** Replaces the account and quota gauges wholesale. Called per scrape, never per request. */
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
  readonly now?: () => Date
  /**
   * The commit `router_build_info{revision}` reports. Defaults to `UNKNOWN_REVISION` so a build
   * nobody stamped says so, rather than inheriting some other build's sha.
   */
  readonly revision?: string
}

/**
 * Ceiling on label text taken from a request body. Not an operator knob: a model name is a
 * client-supplied string, and an unbounded one would put a kilobyte into an exposition line.
 */
const MAX_LABEL_CHARS = 64

/**
 * In-flight requests whose last attempt failed, held until a later attempt proves a failover.
 * Bounds memory when a chain ends in failure and its entry is therefore never resolved; the
 * oldest is dropped, uncounted, rather than kept forever.
 */
const MAX_PENDING_HOPS = 1_024

const UNKNOWN = "unknown"

/** `path` on `router_overhead_seconds`, as the spec spells it. */
const EGRESS_PATH: Readonly<Record<EgressMode, string>> = {
  passthrough: "passthrough",
  translate: "translate",
  "agent-sdk": "agent_sdk",
}

/** `reason` on `router_failovers_total`. Anything not quota, credits, or a deadline is upstream. */
function failoverReason(outcome: UsageOutcome): string {
  if (outcome === "quota_exhausted") return "rate_limited"
  if (outcome === "credits_exhausted") return "exhausted"
  if (outcome === "upstream_timeout") return "timeout"
  return "upstream_error"
}

interface PendingHop {
  readonly pool_id: string
  readonly from_provider: ProviderId
  readonly reason: string
}

export function createMetrics(options: MetricsOptions = {}): RouterMetrics {
  const now = options.now ?? (() => new Date())
  const s = createSeries(options)
  const pending = new Map<string, PendingHop>()
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

  /** Counts the hop the previous failed attempt of this request turned out to be. */
  const settleFailover = (record: UsageRecord): void => {
    const prior = pending.get(record.correlationId)
    if (prior !== undefined) {
      pending.delete(record.correlationId)
      s.failovers.inc(prior)
    }
    if (record.outcome === USAGE_OUTCOME_SUCCESS || record.provider === null) return
    if (pending.size >= MAX_PENDING_HOPS) {
      const oldest = pending.keys().next()
      if (!oldest.done) pending.delete(oldest.value)
    }
    pending.set(record.correlationId, {
      pool_id: record.poolId ?? "none",
      from_provider: record.provider,
      reason: failoverReason(record.outcome),
    })
  }

  const observeTokens = (record: UsageRecord, provider: ProviderId, accountId: string): void => {
    const model = label(record.model)
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
    observeRequest(sample) {
      const ingress_dialect = sample.ingressDialect
      const model = label(sample.model ?? UNKNOWN)
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
      s.costBasis.inc({ provider, model: label(record.model), basis: record.costBasis })
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
      // A replica that lost the advisory lock did not run: it has no duration, processed nothing,
      // and must not reset the failure streak the replica that *is* running has accumulated.
      if (tick.status === "skipped_locked") return

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

    setAccounts(accounts) {
      s.accounts.clear()
      s.quotaUtilization.clear()
      s.quotaReset.clear()
      s.quotaLastChecked.clear()
      s.breakerState.clear()
      const at = now().getTime()

      const counts = new Map<string, number>()
      for (const account of accounts) {
        const key = `${account.provider} ${account.status}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        setQuota(s, account, at)
        for (const phase of BREAKER_PHASES) {
          s.breakerState.set(
            { account_id: account.id, phase },
            phase === account.breakerPhase ? 1 : 0,
          )
        }
      }
      // Every status of every provider present, zeros included: an alert on `exhausted` must see
      // the number fall to zero, not watch the series vanish.
      for (const provider of new Set(accounts.map((account) => account.provider))) {
        for (const status of AccountStatus.options) {
          s.accounts.set({ provider, status }, counts.get(`${provider} ${status}`) ?? 0)
        }
      }
    },

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
 * An `exhausted` account has no reset to report, so `router_quota_reset_seconds` is absent for it
 * rather than zero — a countdown of zero reads as "back any second now", which is the opposite of
 * what a drained balance means.
 */
function setQuota(s: ReturnType<typeof createSeries>, account: AccountMetric, at: number): void {
  let lastChecked: number | null = null
  for (const state of account.quotaWindows ?? []) {
    const account_id = account.id
    const window = state.window
    if (state.utilization !== undefined) {
      s.quotaUtilization.set({ account_id, window }, state.utilization)
    }
    if (state.resetsAt !== undefined && account.status !== "exhausted") {
      const seconds = Math.max(0, (state.resetsAt.getTime() - at) / 1_000)
      s.quotaReset.set({ account_id, window, source: state.resetSource }, seconds)
    }
    const checkedAt = state.lastCheckedAt.getTime()
    lastChecked = lastChecked === null ? checkedAt : Math.max(lastChecked, checkedAt)
  }
  if (lastChecked !== null) s.quotaLastChecked.set({ account_id: account.id }, lastChecked / 1_000)
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
