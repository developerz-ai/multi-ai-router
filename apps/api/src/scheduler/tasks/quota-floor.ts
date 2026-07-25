import type { AccountRepository, QuotaWindowRow } from "@multi-ai-router/db"
import type { HealthStore } from "../../services/dataplane"
import type { ScheduledTask } from "../types"

/**
 * The slow quota floor for **idle** accounts.
 *
 * Quota freshness is bounded by traffic, not by a poll: `rate_limit_event` and
 * rate-limit headers ride responses the router is already making, so an actively
 * used account's reading is as fresh as its last request and polling it would
 * buy nothing (docs/idea/01-architecture.md, "The periodic tasks";
 * docs/idea/11-anthropic-agent-sdk.md §5). This task is the floor under the
 * accounts that traffic never reaches — the ones whose stored reading would
 * otherwise sit frozen at whatever the last request months ago observed.
 *
 * **Idle means "no live signal within one floor interval".** The threshold is
 * the interval itself rather than a knob of its own, and that is not laziness:
 * the floor's whole job is to cover exactly what traffic did not, so any other
 * number would either duplicate work the data plane already did or leave a gap
 * between the two.
 *
 * **It only ever clears a reading that has expired by its own timestamp.** A
 * window whose `resetsAt` has passed has refilled — routing already reads it
 * that way (`services/routing/quota.ts`, `isWindowSpent`) — so leaving the spent
 * utilization on the row means the console shows an account as blocked that the
 * router is happily selecting. What replaces it is `none` / `unknown`, never a
 * zero: we did not observe a refill, we observed that the old number stopped
 * being a fact, and writing 0% would be inventing a reading. `lastCheckedAt`
 * moves so the gauge beside it stays honest about its own age.
 *
 * That clear-only shape is also what makes the task safe under the advisory
 * lock. `HealthStore` is *this process's* memory, so the replica holding the
 * lock may not be the replica that served an account's last request and can
 * call it idle when it is not. The cost of that mistake is one write that
 * removes an already-expired number — never the loss of a live reading.
 *
 * **An `exhausted` account is never touched, and it falls out rather than being
 * special-cased.** Out of credits has no reset by definition, so its row carries
 * a NULL `resetsAt` and the predicate below cannot select it. Nothing here ever
 * puts a countdown on a condition only a human can fix.
 *
 * What is **not** here: fetching a fresh reading. The spec's floor also reads a
 * provider's usage endpoint for idle subscription accounts
 * (docs/idea/11-anthropic-agent-sdk.md §5), and that probe does not exist yet —
 * it belongs with the Claude SDK driver, behind the same per-provider seam the
 * half-open probe will use. Until it lands this task expires stale readings and
 * claims nothing more; the one thing it must never do is fill the gap by
 * guessing a number.
 */

export interface QuotaFloorDeps {
  readonly accounts: Pick<AccountRepository, "list" | "listQuotaWindows" | "upsertQuotaWindow">
  /** Read-only: the floor never marks health, it only asks how fresh the live signal is. */
  readonly health: Pick<HealthStore, "stateOf">
  /** `QUOTA_FLOOR_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** How stale the last live signal must be before an account counts as idle. */
  readonly idleAfterMs: number
}

export function createQuotaFloorTask(deps: QuotaFloorDeps): ScheduledTask {
  return {
    name: "quota_floor_refresh",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const accounts = await deps.accounts.list({})
      const idle = accounts.filter((account) => isIdle(deps, account.id, now))

      // Two queries for the whole fleet, not two per account: many accounts of
      // one provider is the normal case here, so anything per-account in the
      // read path becomes N queries the moment an operator adds a fifth
      // subscription.
      const windows = await deps.accounts.listQuotaWindows(idle.map((account) => account.id))
      const expired = windows.filter((window) => hasRefilled(window, now))

      let refreshed = 0
      for (const window of expired) {
        // Between writes, not between accounts: a fleet with many stale windows
        // must still stop promptly, and each write is independently complete.
        if (signal.aborted) {
          logger.info("quota floor", { outcome: "partial", refreshed, idle: idle.length })
          return { outcome: "partial", itemsProcessed: refreshed }
        }

        await deps.accounts.upsertQuotaWindow(window.accountId, {
          window: window.window,
          utilizationSource: "none",
          resetSource: "unknown",
          lastCheckedAt: now,
        })
        refreshed += 1
      }

      logger.info("quota floor", {
        outcome: "success",
        refreshed,
        idle: idle.length,
        active: accounts.length - idle.length,
      })
      return { outcome: "success", itemsProcessed: refreshed }
    },
  }
}

/** No live signal within one floor interval. An account never seen at all is idle. */
function isIdle(deps: Pick<QuotaFloorDeps, "health" | "idleAfterMs">, id: string, now: Date) {
  const lastSignalAt = deps.health.stateOf(id).lastSignalAt
  if (lastSignalAt === null) return true
  return now.getTime() - lastSignalAt.getTime() >= deps.idleAfterMs
}

/**
 * The window's own reset has passed, so whatever it carries stopped being a
 * statement about the present.
 *
 * This one predicate is also the whole of the task's idempotency: clearing a
 * row nulls its `resetsAt`, so the row can never match again and a second run
 * selects nothing. No cursor, no marker column, no bookkeeping.
 */
function hasRefilled(window: QuotaWindowRow, now: Date): boolean {
  return window.resetsAt !== null && window.resetsAt.getTime() <= now.getTime()
}
