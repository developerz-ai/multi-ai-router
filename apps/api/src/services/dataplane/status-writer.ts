import { type AccountStatus, describeError } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"

/**
 * The router's own verdict about an account, made durable — off the request path.
 *
 * The breaker is in-memory routing hygiene and mostly deserves to be: a cooldown is a few minutes
 * of arithmetic and re-deriving it after a restart costs one failed request. **A standing block is
 * a different kind of fact.** `exhausted` means a human has to buy something and `needs_reauth`
 * means a human has to log in, so the only thing that ends either one is a person who has to be
 * *told* — and until this writer existed nobody was: the verdict lived in one replica's memory,
 * vanished on deploy, and left CLAUDE.md's red "needs top-up" dashboard banner and the accounts
 * screen reading a row that still said `active`. The first request after a restart re-marked the
 * account, which is fine for routing and useless for the operator, because the surface that was
 * supposed to tell them was reset by the same restart.
 *
 * So: the two standing blocks are written through to `accounts.status`, and nothing else is. A
 * cooldown is not persisted (a clock recovers it, and a stored countdown is stale the moment the
 * process holding it dies), and neither is a recovery — see {@link overwritable} for why the clear
 * belongs to the operator's "Re-check now" and to the reauth flows instead.
 *
 * Same three properties as `quota-writer.ts`, for the same reasons:
 *
 * - **`record` never awaits, never queries, never throws.** It is one map write. The `UPDATE`
 *   happens on a timer, on its own thread of control (CLAUDE.md non-negotiable 8).
 * - **Pending state coalesces, and coalescing is correct here.** A status is state, not an event:
 *   fifty concurrent requests all seeing the same `402` are one verdict, not fifty, and pending can
 *   never exceed one entry per account. `usage/recorder.ts` is the bounded queue to reach for when
 *   the thing being written is a fact about the past that must not be lost.
 * - **A failed write costs visibility, never traffic.** The breaker still holds the verdict, so
 *   routing is unaffected and the next transition writes the row again.
 *
 * It is deliberately not a scheduled task: an advisory lock would have one replica persist its own
 * observations and silently drop every other replica's.
 */

/**
 * The statuses this writer is allowed to make durable — the two standing blocks the breaker forms
 * on its own. `disabled` is not among them even though the breaker can produce it (an `api-key`
 * account whose key is refused): storing it would make a provider's bad `401` indistinguishable
 * from the operator having switched the account off, and only the operator can undo that one.
 */
export type ObservedAccountStatus = "exhausted" | "needs_reauth"

/**
 * Whether a breaker verdict is one this writer may store.
 *
 * The whole exclusion policy, stated once, so the health store can report *every* block it forms
 * without also having to know which of them are persistable — see {@link ObservedAccountStatus}.
 */
export function persistable(status: AccountStatus): status is ObservedAccountStatus {
  return status === "exhausted" || status === "needs_reauth"
}

/**
 * Which stored statuses an observed verdict may overwrite.
 *
 * Two rules, and the guard is the whole policy:
 *
 * 1. **`disabled` is never overwritten.** It is the operator's word about the account, not an
 *    observation about the upstream, and no response from a provider revises it.
 * 2. **A standing block is never overwritten by another standing block.** The first one recorded is
 *    the one an operator is looking at and acting on; the account is out of rotation either way, so
 *    rewriting `needs_reauth` as `exhausted` would change the remedy on their screen while they
 *    were carrying it out. (It is also unreachable in practice — candidate filtering drops both, so
 *    no attempt can produce a second verdict — which is exactly why it must not be *encoded* as
 *    reachable.)
 *
 * A recovery is not in this vocabulary at all. Clearing `exhausted` is the operator's "Re-check
 * now" (`services/accounts/recheck.ts`), which does it on the request path where a `refreshCatalog`
 * can follow it; clearing `needs_reauth` is a completed login, and only a completed login
 * (`accounts/refresh/status.ts`, `accounts/connect/`, `health/claudeAuthProbe.ts`).
 */
export const OVERWRITABLE_BY_OBSERVATION: readonly AccountStatus[] = ["active", "cooling_down"]

export interface AccountStatusWriterDeps {
  readonly accounts: Pick<AccountRepository, "updateStatusWhen">
  readonly logger: Logger
  /** `ACCOUNT_STATUS_WRITE_INTERVAL_MS`. How long a verdict may sit in memory before it is durable. */
  readonly flushIntervalMs: number
  readonly now: () => Date
}

export interface AccountStatusWriterStats {
  /** Accounts whose latest verdict has not been written yet. */
  readonly pending: number
  /** Rows the guard actually changed. Monotonic. */
  readonly written: number
  /** Writes the guard declined — the row was `disabled`, already blocked, or gone. Monotonic. */
  readonly refused: number
  /** Writes the database rejected. Monotonic. The breaker keeps the verdict; the row lags. */
  readonly writeFailures: number
}

export interface AccountStatusWriter {
  /**
   * Enqueue one account's current verdict. Synchronous, non-throwing, off the hot path.
   *
   * A status this writer may not store is dropped here rather than at the call site, so the health
   * store reports every block it forms and exactly one file decides which of them are durable.
   */
  record(accountId: string, status: AccountStatus): void
  /**
   * Drops a pending verdict for one account.
   *
   * Wired to `HealthStore.reset`, which is the operator's "Re-check now" and account deletion. Both
   * mean the stored status is about to be settled by someone with more authority than an observation
   * made a moment ago, and a queued `exhausted` landing *after* that would undo a button press with
   * no visible cause. A write already in flight is not recalled and does not need to be: the clear
   * that follows is issued afterwards and postgres serializes the two on the row.
   */
  forget(accountId: string): void
  /** Writes everything pending. Used by tests, by shutdown, and by the flush timer. */
  flush(): Promise<void>
  start(): void
  /** Stops the timer and writes what is left, so a clean shutdown loses no verdict. */
  stop(): Promise<void>
  stats(): AccountStatusWriterStats
}

export function createAccountStatusWriter(deps: AccountStatusWriterDeps): AccountStatusWriter {
  const log = deps.logger.child({ component: "account-status" })
  const pending = new Map<string, ObservedAccountStatus>()

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let written = 0
  let refused = 0
  let writeFailures = 0

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return
    // Taken before the first await: a verdict that arrives mid-flush belongs to the next one, not
    // to a batch already being written, and must not be dropped by the clear that follows it.
    const batch = [...pending.entries()]
    pending.clear()

    let failed = 0
    let lastError: unknown = null

    for (const [accountId, status] of batch) {
      try {
        const row = await deps.accounts.updateStatusWhen(
          accountId,
          OVERWRITABLE_BY_OBSERVATION,
          status,
          deps.now(),
        )
        if (row === undefined) {
          refused += 1
          continue
        }
        written += 1
        // One line per applied transition, and applied transitions are rare by construction: an
        // account goes `exhausted` once and stays there until a human acts. This is the line an
        // operator greps when the console shows a block they did not make.
        log.warn("account parked by the router", { accountId, status })
      } catch (error) {
        // Not re-queued: the breaker still holds the verdict, routing is already acting on it, and
        // re-queueing a row the database refuses would loop on the failure.
        writeFailures += 1
        lastError = error
        failed += 1
      }
    }

    // One line per flush, whatever the batch size: a database that is down fails every row, and a
    // line each would make the outage's own logs the reason nobody can read the outage.
    if (failed > 0) {
      log.warn("account status writes failed — routing holds the verdict, stored rows lag", {
        accounts: failed,
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
    record(accountId, status) {
      if (!persistable(status)) return
      pending.set(accountId, status)
    },

    forget(accountId) {
      pending.delete(accountId)
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

    stats: () => ({ pending: pending.size, written, refused, writeFailures }),
  }
}
