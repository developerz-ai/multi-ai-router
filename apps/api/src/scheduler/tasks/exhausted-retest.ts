import { describeError } from "@multi-ai-router/core"
import type { ExhaustedWatchRepository, ExhaustedWatchState } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { RoutableAccount } from "../../services/dataplane/types"
import type { AccountSnapshot } from "../../services/routing"
import {
  type ExhaustedRetestSchedule,
  type ExhaustedWatch,
  stepExhaustedWatch,
} from "../../services/routing/exhausted-retest"

/**
 * The `exhausted` half of `cooldown_recheck`: the bounded re-test rule 7 now requires
 * (`services/routing/exhausted-retest.ts` owns the clock).
 *
 * **The operator's button, pressed on a clock.** A re-test is exactly "Re-check now": the stored
 * `exhausted` is cleared, the account is offered to one recovery probe, and that probe's verdict —
 * the next real request, or the router's own probe — puts a still-drained account straight back.
 * One code path, one durable cooldown, one audit kind; nothing here sends a request of its own.
 *
 * **The ladder is shared, not per replica.** Each account's count and next due instant live in
 * `account_exhausted_watches`, read at the start of every tick and written back per account the tick
 * stepped. The advisory lock hands the tick to whichever replica wins, and a restart no longer
 * resets a week-old `exhausted` account to its first one-hour re-test.
 *
 * **A re-test that threw is no re-test** (03.7): the claim may never have been taken, so the count
 * and the wait stand and the next tick asks again — exactly like a refused claim.
 *
 * **Every re-test is an alert.** The warn line below is the contract an alert rule matches on
 * (docs/idea/08-observability.md): an `exhausted` account is capacity a human must restore, and
 * the re-test is the moment the router says so again, with when it will look next.
 */

export interface ExhaustedRetestPorts {
  /**
   * "Re-check now" for one account, attributed to this task. `refused`: the claim was not taken (an
   * operator's check holds the lease, or the recheck cooldown is running) — no re-test happened.
   * Throws only when it could not run.
   */
  readonly recheck: (accountId: string) => Promise<"rechecked" | "refused">
  readonly schedule: ExhaustedRetestSchedule
  /** Where the ladder lives. Absent: one process's memory (tests, and nothing wired). */
  readonly store?: ExhaustedWatchStore
}

export type ExhaustedWatchStore = Pick<ExhaustedWatchRepository, "list" | "save" | "remove">

/** The ladder in one process's memory: the same contract as the table, for tests and fallbacks. */
export function memoryExhaustedWatchStore(): ExhaustedWatchStore {
  const rows = new Map<string, ExhaustedWatchState>()
  return {
    list: async () => [...rows].map(([accountId, watch]) => ({ accountId, ...watch })),
    save: async (accountId, watch) => {
      rows.set(accountId, watch)
      return true
    },
    remove: async (accountId) => rows.delete(accountId),
  }
}

const toState = (watch: ExhaustedWatch): ExhaustedWatchState => ({
  retests: watch.retests,
  dueAt: new Date(watch.dueAt),
  lastRetestAt: watch.lastRetestAt === null ? null : new Date(watch.lastRetestAt),
})

export interface ExhaustedRetestTick {
  readonly accounts: () => readonly RoutableAccount[]
  /** Live status, so a verdict held only in memory counts as well as a stored one. */
  readonly snapshot: (accountId: string) => AccountSnapshot | undefined
  readonly now: Date
  readonly logger: Logger
  readonly signal: AbortSignal
}

/** Returns a tick function; it answers how many accounts it re-tested. */
export function createExhaustedRetest(
  ports: ExhaustedRetestPorts,
): (tick: ExhaustedRetestTick) => Promise<number> {
  const store = ports.store ?? memoryExhaustedWatchStore()

  return async ({ accounts, snapshot, now, logger, signal }) => {
    const nowMs = now.getTime()
    const known = accounts()
    const knownIds = new Set(known.map((account) => account.id))
    const watches = new Map<string, ExhaustedWatch>()
    for (const row of await store.list()) {
      // Pruned here; a deleted account's row is also cascaded away by its foreign key.
      if (!knownIds.has(row.accountId)) {
        await store.remove(row.accountId)
        continue
      }
      watches.set(row.accountId, {
        retests: row.retests,
        dueAt: row.dueAt.getTime(),
        lastRetestAt: row.lastRetestAt?.getTime() ?? null,
      })
    }

    let retested = 0
    for (const account of known) {
      if (signal.aborted) break
      const exhausted = snapshot(account.id)?.status === "exhausted"
      const prior = watches.get(account.id)
      const step = stepExhaustedWatch(prior, exhausted, nowMs, ports.schedule)
      if (!step.retest || step.watch === undefined) {
        if (step.watch === undefined) {
          if (prior !== undefined) await store.remove(account.id)
        } else if (step.watch !== prior) await store.save(account.id, toState(step.watch))
        continue
      }

      const fields = {
        accountId: account.id,
        provider: account.driver.provider,
        retest: step.watch.retests,
        nextRetestAt: new Date(step.watch.dueAt).toISOString(),
      }
      try {
        if ((await ports.recheck(account.id)) === "refused") {
          // Nothing was re-tested: the count and the wait stand, and the next tick asks again.
          logger.info("exhausted account re-test refused", { accountId: account.id })
          continue
        }
      } catch (error) {
        // Same as refused: the stored watch is not advanced, so the next tick tries again.
        logger.error("exhausted account re-test failed", {
          ...fields,
          error: describeError(error, Number.POSITIVE_INFINITY),
        })
        continue
      }
      await store.save(account.id, toState(step.watch))
      retested += 1
      logger.warn("exhausted account re-tested", fields)
    }
    return retested
  }
}
