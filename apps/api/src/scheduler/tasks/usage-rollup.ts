import type { ScheduledTaskRepository, UsageDailyRepository } from "@multi-ai-router/db"
import { startOfNextUtcDay, startOfUtcDay } from "@multi-ai-router/db"
import type { RetentionConfig } from "../../config/env"
import type { ScheduledTask } from "../types"

/**
 * Raw `usage_records` → per-day, per-(key, account, pool, model) aggregates.
 *
 * The reason this task exists is retention, not speed: raw rows expire on
 * `RETENTION_USAGE_DAYS` and the rollup does not, so a lifetime total has to be
 * banked before the rows that earned it are swept
 * (docs/idea/08-observability.md, "Why it stays fast").
 *
 * **Every window it asks for is a whole UTC day, and the statement replaces
 * rather than accumulates**, which is where idempotency comes from — re-running
 * a day recomputes it, so a retry, a restart, and two overlapping ticks all
 * converge on the same numbers. The whole design of the cursor below follows
 * from that one property: overlapping is free, so the safe move is always to
 * ask for *more* days than strictly necessary.
 *
 * The window is `[from, now]`, and `from` is the earliest of three answers,
 * clamped to the retention floor:
 *
 * - **the last successful run's start** — normally an hour ago, so the steady
 *   state re-closes today and nothing else;
 * - **the start of yesterday**, always. A tick that fails in the hour spanning
 *   midnight would otherwise leave that day half-rolled forever, since the next
 *   tick's cursor already sits past it. Re-closing yesterday every hour costs
 *   one extra day of scan and removes the entire class of boundary bug;
 * - **the retention floor** as a hard lower bound — see below.
 *
 * With no successful run on record the window opens all the way to the floor.
 * That is the first-boot backfill: an existing deployment upgrading into this
 * task banks every day it still has raw rows for, once, instead of silently
 * losing them to the janitor. A fresh install scans nothing, because there is
 * nothing there.
 *
 * **The window is walked one day at a time, and a day is the batch.** That
 * backfill is up to the whole retention floor wide, so issuing it as a single
 * statement would put 90 days of the write-heaviest table in the schema inside
 * one transaction — the unbounded sweep non-negotiable 13 exists to forbid.
 * A day is the smallest window that can be *replaced* rather than accumulated,
 * so it is the smallest honest batch: each day commits on its own, the shutdown
 * signal is checked between days and never mid-statement, and a run that stops
 * with days left reports `partial`.
 *
 * `partial` here means "there is more", not "resume exactly here". The next tick
 * recomputes from the same cursor, because a replaced day is idempotent and a
 * durable per-day cursor would buy only the rework — the days already banked are
 * committed and correct either way.
 *
 * **The floor is what keeps the rollup from eating its own history.** Recomputing
 * a day the janitor has begun to sweep would replace a complete total with
 * whatever fraction of the rows survived, so the scan may never reach back past
 * the first day the retention window still covers in full.
 *
 * Lag, stated plainly: the most recent closed day is only as complete as the
 * last tick that ran after it ended, so for up to one interval after midnight
 * yesterday's rolled row can be missing its final hour. That is inherent to
 * rolling up on a timer, and it is why the read service treats *today* as the
 * partial day rather than trusting a fresh rollup row for it.
 */

export interface UsageRollupDeps {
  readonly usageDaily: Pick<UsageDailyRepository, "rollupDay">
  /** The cursor. `lastSuccess`, never `lastRun` — see the repository's note on why. */
  readonly scheduledTasks: Pick<ScheduledTaskRepository, "lastSuccess">
  /** `RETENTION_USAGE_DAYS`: how far back raw rows are guaranteed to be complete. */
  readonly retention: Pick<RetentionConfig, "usageDays">
  /** `USAGE_ROLLUP_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
}

const DAY_MS = 24 * 60 * 60 * 1_000

export function createUsageRollupTask(deps: UsageRollupDeps): ScheduledTask {
  return {
    name: "usage_rollup",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const from = rollupFrom(now, await deps.scheduledTasks.lastSuccess("usage_rollup"), deps)
      const days = rollupDays(from, now)

      let rolled = 0
      let remaining = false
      for (const day of days) {
        // Between days, never mid-statement: a day that has begun is finished,
        // and everything after it is the next tick's to redo.
        if (signal.aborted) {
          remaining = true
          break
        }
        rolled += await deps.usageDaily.rollupDay(day)
      }

      const outcome = remaining ? "partial" : "success"
      // Silent on a tick that found nothing to do at all — a fresh install would
      // otherwise log an empty rollup every hour forever.
      if (days.length > 0) {
        logger.info("usage rollup", {
          outcome,
          rolled,
          fromDay: from.toISOString(),
          days: days.length,
        })
      }
      return { outcome, itemsProcessed: rolled }
    },
  }
}

/**
 * Every UTC day the `[from, now]` window touches, oldest first — the batches, in
 * the order they are issued.
 *
 * Oldest first so a backfill banks the days closest to the janitor's cutoff
 * before the ones it has the most time left to bank, and so an interrupted run
 * leaves the *newest* days outstanding, which the next tick would recompute
 * anyway.
 *
 * Empty when `from` is not before `now`, which can only happen if the clock went
 * backwards past the floor: nothing to scan is a genuine no-op, never an
 * empty-range statement.
 */
export function rollupDays(from: Date, now: Date): readonly Date[] {
  if (from.getTime() >= now.getTime()) return []

  const days: Date[] = []
  const today = startOfUtcDay(now).getTime()
  for (let day = startOfUtcDay(from).getTime(); day <= today; day += DAY_MS) {
    days.push(new Date(day))
  }
  return days
}

/**
 * The start of the scan window. Pure, so the cursor rules above are testable
 * against a clock and a row rather than against a database.
 */
export function rollupFrom(
  now: Date,
  lastSuccess: { readonly startedAt: Date } | undefined,
  deps: Pick<UsageRollupDeps, "retention">,
): Date {
  const yesterday = startOfUtcDay(now).getTime() - DAY_MS
  const cursor =
    lastSuccess === undefined ? Number.NEGATIVE_INFINITY : lastSuccess.startedAt.getTime()

  // The first day the janitor's window still covers end to end. `startOfNext`
  // and not `startOfUtcDay`: the day the cutoff falls in is *mid-sweep*, so its
  // surviving rows are already an undercount of what it earned.
  const floor = startOfNextUtcDay(new Date(now.getTime() - deps.retention.usageDays * DAY_MS))

  return new Date(Math.max(floor.getTime(), Math.min(cursor, yesterday)))
}
