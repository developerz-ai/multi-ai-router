import { describeError } from "@multi-ai-router/core"
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
}

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
  // Per account, so bounded by the account count; pruned every tick.
  const watches = new Map<string, ExhaustedWatch>()

  return async ({ accounts, snapshot, now, logger, signal }) => {
    const nowMs = now.getTime()
    const known = accounts()
    for (const id of watches.keys())
      if (!known.some((account) => account.id === id)) watches.delete(id)

    let retested = 0
    for (const account of known) {
      if (signal.aborted) break
      const exhausted = snapshot(account.id)?.status === "exhausted"
      const prior = watches.get(account.id)
      const step = stepExhaustedWatch(prior, exhausted, nowMs, ports.schedule)
      if (step.watch === undefined) watches.delete(account.id)
      else watches.set(account.id, step.watch)
      if (!step.retest || step.watch === undefined) continue

      const fields = {
        accountId: account.id,
        provider: account.driver.provider,
        retest: step.watch.retests,
        nextRetestAt: new Date(step.watch.dueAt).toISOString(),
      }
      try {
        if ((await ports.recheck(account.id)) === "refused") {
          // Nothing was re-tested: the count and the wait stand, and the next tick asks again.
          if (prior !== undefined) watches.set(account.id, prior)
          logger.info("exhausted account re-test refused", { accountId: account.id })
          continue
        }
        retested += 1
        logger.warn("exhausted account re-tested", fields)
      } catch (error) {
        logger.error("exhausted account re-test failed", {
          ...fields,
          error: describeError(error, Number.POSITIVE_INFINITY),
        })
      }
    }
    return retested
  }
}
