import { describeError, type QuotaWindowState } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { createWriterLifecycle } from "../shutdown/writer-lifecycle"
import type { HealthObservation } from "./health-observation"
import { mergePendingQuota, type PendingQuotaReading } from "./quota-writer-observation"

/**
 * Quota readings, made durable — off the request path.
 *
 * A reading arrives on a response the router was already making and folds into the health store,
 * which is in-memory and per replica. That is enough for the process that observed it and for
 * nothing else: a restart, a second replica, or the console asking about an account this replica
 * has not served leaves every gauge, countdown, and `quota-window-spent` verdict reading from
 * whatever was persisted. Persisted, until now, by nobody — `quota_windows` had exactly one writer
 * and it only ever *cleared* expired rows (`scheduler/tasks/quota-floor.ts`).
 *
 * Three properties make this safe to hang off `HealthStore.applyRateLimit`:
 *
 * - **`record` never awaits, never queries, never throws.** It writes one map entry and returns.
 *   The insert happens on a timer, on its own thread of control (CLAUDE.md non-negotiable 8).
 * - **Pending state coalesces, and coalescing is *correct* here.** A quota window is state, not an
 *   event: the newest reading per window supersedes older evidence, with conservative equal-clock ties, so there is no
 *   queue to bound and nothing to shed. Pending can never exceed one entry per account, which is
 *   why this is a map and `usage/recorder.ts` — which records history and must not lose a row — is
 *   a bounded queue. Reach for that one when the thing being written is a fact about the past.
 * - **A failed write costs freshness, never traffic.** The reading stays live in memory and the
 *   failed window is retained for the next flush, merged behind newer pending evidence. Each flush attempts a window once; shutdown adds at most one final pass within its time budget.
 *
 * It is deliberately not a scheduled task. Those hold a `pg_try_advisory_lock` so exactly one
 * replica sweeps, and a reading lives in the memory of the replica that *observed* it — the
 * lock-holder would persist its own accounts and silently drop every other replica's.
 */

export interface QuotaWindowWriterDeps {
  readonly accounts: Pick<AccountRepository, "upsertQuotaWindow"> &
    Partial<Pick<AccountRepository, "upsertObservedQuotaWindow">>
  readonly logger: Logger
  /** `QUOTA_WRITE_INTERVAL_MS`. How long a reading may sit in memory before it is durable. */
  readonly shutdownDrainMs?: number
  readonly flushIntervalMs: number
}

export interface QuotaWindowWriterStats {
  /** Accounts whose latest reading has not been written yet. */
  readonly rejectedAfterStop: number
  readonly pending: number
  /** Rows upserted since construction. Monotonic. */
  readonly written: number
  /** Rows a write rejected. Monotonic. The reading survives; the row is a flush behind. */
  readonly writeFailures: number
}

export interface QuotaWindowWriter {
  /** Enqueue one account's whole current reading. Synchronous, non-throwing, off the hot path. */
  record(
    accountId: string,
    windows: readonly QuotaWindowState[],
    observation?: HealthObservation,
  ): void
  /** Writes everything pending. Used by tests, by shutdown, and by the flush timer. */
  flush(): Promise<void>
  start(): void
  /** Closes admission and drains current plus final pending batch within a configured bound. */
  stop(): Promise<void>
  stats(): QuotaWindowWriterStats
}

export function createQuotaWindowWriter(deps: QuotaWindowWriterDeps): QuotaWindowWriter {
  const log = deps.logger.child({ component: "quota" })
  const pending = new Map<string, PendingQuotaReading>()

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let unsettled = 0
  let rejectedAfterStop = 0
  let written = 0
  let writeFailures = 0

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return
    // Taken before the first await: a reading that arrives mid-flush belongs to the next one, not
    // to a batch already being written, and must not be dropped by the clear that follows it.
    const batch = [...pending.entries()]
    pending.clear()
    unsettled = batch.length

    let failedAccounts = 0
    let lastError: unknown = null

    for (const [accountId, reading] of batch) {
      let failed = false
      for (const window of reading.windows) {
        if (!lifecycle.canWrite()) {
          pending.set(
            accountId,
            mergePendingQuota(
              { ...reading, windows: [window] },
              pending.get(accountId) ?? { ...reading, windows: [] },
            ),
          )
          continue
        }
        try {
          if (reading.observation === undefined) {
            await deps.accounts.upsertQuotaWindow(accountId, window)
          } else {
            if (deps.accounts.upsertObservedQuotaWindow === undefined)
              throw new Error("observed quota persistence is not configured")
            const row = await deps.accounts.upsertObservedQuotaWindow({
              accountId,
              state: window,
              expected: {
                ...reading.observation,
                recoveryGeneration: reading.observation.recoveryGeneration ?? null,
              },
            })
            if (row === undefined) continue
          }
          written += 1
        } catch (error) {
          // Retry at the next flush, merging with newer pending facts rather than overwriting them.
          pending.set(
            accountId,
            mergePendingQuota(
              { ...reading, windows: [window] },
              pending.get(accountId) ?? { ...reading, windows: [] },
            ),
          )
          writeFailures += 1
          lastError = error
          failed = true
        }
      }
      unsettled -= 1
      if (failed) failedAccounts += 1
    }

    // One line per flush, whatever the batch size: a database that is down fails every row, and a
    // line each would make the outage's own logs the reason nobody can read the outage.
    if (failedAccounts > 0) {
      log.warn("quota window writes failed — readings stay live, stored rows lag", {
        accounts: failedAccounts,
        rows: writeFailures,
        reason: describeError(lastError, Number.POSITIVE_INFINITY),
      })
    }
  }

  /** One drain at a time: two batches racing into the same row would settle in arrival order. */
  const flush = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    const run = drain().finally(() => {
      inFlight = null
      unsettled = 0
    })
    inFlight = run
    return run
  }

  const lifecycle = createWriterLifecycle({
    flush,
    pending: () => pending.size,
    outstanding: () => pending.size + unsettled,
    timeoutMs: deps.shutdownDrainMs ?? 15_000,
    warn: (pending) =>
      log.warn("writer shutdown incomplete; unconfirmed writes remain", { pending }),
  })

  return {
    record(accountId, windows, observation) {
      if (!lifecycle.accepting()) {
        rejectedAfterStop += 1
        return
      }
      if (windows.length === 0) return
      const snapshot = windows.map((window) => ({
        ...window,
        lastCheckedAt: new Date(window.lastCheckedAt),
        ...(window.resetsAt === undefined ? {} : { resetsAt: new Date(window.resetsAt) }),
      }))
      pending.set(
        accountId,
        mergePendingQuota(pending.get(accountId), {
          windows: snapshot,
          ...(observation === undefined ? {} : { observation: { ...observation } }),
        }),
      )
    },

    flush,

    start() {
      if (!lifecycle.start()) return
      if (timer !== null) return
      timer = setInterval(() => {
        void flush()
      }, deps.flushIntervalMs)
      // Reporting must never be the reason a process refuses to exit.
      timer.unref?.()
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      await lifecycle.stop()
    },

    stats: () => ({ rejectedAfterStop, pending: pending.size, written, writeFailures }),
  }
}
