import { describeError, type QuotaWindowState } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"

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
 *   event: the newest reading for an account supersedes the older one outright, so there is no
 *   queue to bound and nothing to shed. Pending can never exceed one entry per account, which is
 *   why this is a map and `usage/recorder.ts` — which records history and must not lose a row — is
 *   a bounded queue. Reach for that one when the thing being written is a fact about the past.
 * - **A failed write costs freshness, never traffic.** The reading stays live in memory and the
 *   next one re-writes the row, so a batch is dropped rather than retried at the head of a queue.
 *
 * It is deliberately not a scheduled task. Those hold a `pg_try_advisory_lock` so exactly one
 * replica sweeps, and a reading lives in the memory of the replica that *observed* it — the
 * lock-holder would persist its own accounts and silently drop every other replica's.
 */

export interface QuotaWindowWriterDeps {
  readonly accounts: Pick<AccountRepository, "upsertQuotaWindow">
  readonly logger: Logger
  /** `QUOTA_WRITE_INTERVAL_MS`. How long a reading may sit in memory before it is durable. */
  readonly flushIntervalMs: number
}

export interface QuotaWindowWriterStats {
  /** Accounts whose latest reading has not been written yet. */
  readonly pending: number
  /** Rows upserted since construction. Monotonic. */
  readonly written: number
  /** Rows a write rejected. Monotonic. The reading survives; the row is a flush behind. */
  readonly writeFailures: number
}

export interface QuotaWindowWriter {
  /** Enqueue one account's whole current reading. Synchronous, non-throwing, off the hot path. */
  record(accountId: string, windows: readonly QuotaWindowState[]): void
  /** Writes everything pending. Used by tests, by shutdown, and by the flush timer. */
  flush(): Promise<void>
  start(): void
  /** Stops the timer and writes what is left, so a clean shutdown loses no reading. */
  stop(): Promise<void>
  stats(): QuotaWindowWriterStats
}

export function createQuotaWindowWriter(deps: QuotaWindowWriterDeps): QuotaWindowWriter {
  const log = deps.logger.child({ component: "quota" })
  const pending = new Map<string, readonly QuotaWindowState[]>()

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let written = 0
  let writeFailures = 0

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return
    // Taken before the first await: a reading that arrives mid-flush belongs to the next one, not
    // to a batch already being written, and must not be dropped by the clear that follows it.
    const batch = [...pending.entries()]
    pending.clear()

    let failedAccounts = 0
    let lastError: unknown = null

    for (const [accountId, windows] of batch) {
      let failed = false
      for (const window of windows) {
        try {
          await deps.accounts.upsertQuotaWindow(accountId, window)
          written += 1
        } catch (error) {
          // Not re-queued: the live reading is still in memory and the next `rate_limit_event`
          // writes it again. Re-queueing a row the database refuses would loop on the failure.
          writeFailures += 1
          lastError = error
          failed = true
        }
      }
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
    })
    inFlight = run
    return run
  }

  return {
    record(accountId, windows) {
      if (windows.length === 0) return
      pending.set(accountId, windows)
    },

    flush,

    start() {
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
      await flush()
    },

    stats: () => ({ pending: pending.size, written, writeFailures }),
  }
}
