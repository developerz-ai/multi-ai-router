/**
 * The bounded exit from `exhausted`, as a pure step over an injected clock.
 *
 * `exhausted` is still not `cooling_down`: it carries no reset, it is still refused by every
 * candidate filter, and no request is ever routed to it. What changed (rule 7, amended:
 * developerz.ai#7868) is that a park with no exit at all is worse than a cheap re-test. A wall is
 * read from words, and words get misread — MiniMax sat out 10-28 to 11-03 behind a verdict nobody
 * re-checked. So an `exhausted` account is re-tested through the operator's own "Re-check now",
 * first after `firstMs` and then on a clock that doubles per re-test up to one worst-case task tick
 * below `maxMs`. A balance that is truly drained costs one failed probe per `maxMs`; a misread one
 * is back within `firstMs`.
 * Only a re-test that ran is counted: one refused at the door or thrown before any probe left
 * leaves the watch as it was, so the next tick tries again instead of waiting a doubled interval
 * (plan 101, 03.7). This module only computes the next watch; the scheduler task commits it after
 * the re-test answers, and keeps the prior one otherwise.
 *
 * Persisted (`account_exhausted_watches`, through the scheduler task's injected store), so a
 * restart resumes the ladder instead of starting again at `firstMs`. The recheck service's durable
 * cooldown (`ACCOUNT_RECHECK_COOLDOWN_SECONDS`, 60 s by default) stops two re-tests landing in the
 * same window. The task notices an account on its first tick after it went `exhausted`, so the
 * first re-test lands between `firstMs` and `firstMs` plus one task interval later — 1 to 2 h at
 * the defaults.
 *
 * The same tick is why the scheduled wait stops short of `maxMs`: a re-test only ever fires on a
 * tick, so a wait that reached `maxMs` exactly could be carried past it by the tick that fires it.
 * `tickMs` is the worst-case interval the runner arms between two ticks' starts (the jittered
 * interval alone), and {@link retestWaitCapMs} leaves one of them under the cap — so the scheduled
 * `dueAt` is never later than `lastRetestAt + maxMs - tickMs`, strictly under `maxMs`. The instant
 * the re-test actually fires can slip a further `SCHEDULER_TASK_MAX_RUN_MINUTES` (60 min at the
 * defaults), because the runner arms the next timer only once the tick has settled
 * (`scheduler/runner.ts`); the honest outer bound on a re-test-to-re-test gap is therefore
 * `maxMs + SCHEDULER_TASK_MAX_RUN_MINUTES`, not `maxMs`. `maxMs` keeps its meaning as the 24 h
 * contract bound (and as the healthy-probation window in {@link stepExhaustedWatch}).
 */

export interface ExhaustedRetestSchedule {
  /** `EXHAUSTED_RECHECK_FIRST_MINUTES`: the wait before the first re-test, and the base it doubles. */
  readonly firstMs: number
  /** `EXHAUSTED_RECHECK_MAX_MINUTES`: the longest an `exhausted` account goes without a re-test. */
  readonly maxMs: number
  /**
   * The worst-case interval the runner arms between two ticks of the task that runs this ladder:
   * its interval widened by the runner's jitter ({@link worstCaseTickMs}). The scheduled wait must
   * leave this much room under `maxMs`, because only a tick fires a re-test and a tick can be a
   * whole jittered interval late. It is not the whole gap between two tick *starts*: the runner
   * re-arms only after the previous tick settles, so that tick's own bounded run
   * (`SCHEDULER_TASK_MAX_RUN_MINUTES`) adds on top.
   */
  readonly tickMs: number
}

export interface ExhaustedWatch {
  /** Re-tests spent on this account since the watch began. */
  readonly retests: number
  /** Epoch ms the next re-test is due. */
  readonly dueAt: number
  /** Epoch ms of the last re-test, or null before the first. */
  readonly lastRetestAt: number | null
}

export interface ExhaustedStep {
  readonly watch: ExhaustedWatch | undefined
  readonly retest: boolean
}

/**
 * The worst-case interval the runner arms between two ticks of a task: its interval plus the jitter
 * the runner adds, so `intervalMs * (1 + jitterFraction)` rounded. This is what a wait must leave
 * room for, not the bare interval — the gap between two tick *starts* is this plus the previous
 * tick's own bounded run, because the runner re-arms only after a tick settles.
 */
export function worstCaseTickMs(intervalMs: number, jitterFraction: number): number {
  return Math.round(intervalMs * (1 + jitterFraction))
}

/**
 * The longest wait the ladder may schedule: `maxMs` less one worst-case tick, floored at `firstMs`
 * so a cap narrower than the first wait cannot invert the ladder.
 */
export function retestWaitCapMs(schedule: ExhaustedRetestSchedule): number {
  return Math.max(schedule.firstMs, schedule.maxMs - schedule.tickMs)
}

/**
 * The span from a re-test to the next that the schedule itself accounts for: the capped wait plus
 * one worst-case tick. It equals `maxMs` while the cap is `maxMs - tickMs`; the instant the re-test
 * actually fires can slip the firing tick's own bounded run beyond it.
 */
export function retestMaxGapMs(schedule: ExhaustedRetestSchedule): number {
  return retestWaitCapMs(schedule) + schedule.tickMs
}

/**
 * The wait after `retests` re-tests: `firstMs`, doubled per re-test, never past
 * {@link retestWaitCapMs}.
 */
export function retestWait(retests: number, schedule: ExhaustedRetestSchedule): number {
  return Math.min(schedule.firstMs * 2 ** retests, retestWaitCapMs(schedule))
}

/**
 * One look at one account. A re-tested account that reads healthy keeps its watch until it has
 * served a full `maxMs`: between the re-test and the probe's verdict it reads `active`, and a balance
 * that drains again inside a day resumes the doubling instead of starting over at `firstMs`.
 */
export function stepExhaustedWatch(
  watch: ExhaustedWatch | undefined,
  exhausted: boolean,
  nowMs: number,
  schedule: ExhaustedRetestSchedule,
): ExhaustedStep {
  if (!exhausted) {
    const probation =
      watch?.lastRetestAt !== null &&
      watch?.lastRetestAt !== undefined &&
      nowMs - watch.lastRetestAt < schedule.maxMs
    return { watch: probation ? watch : undefined, retest: false }
  }
  if (watch === undefined)
    return {
      watch: { retests: 0, dueAt: nowMs + retestWait(0, schedule), lastRetestAt: null },
      retest: false,
    }
  if (nowMs < watch.dueAt) return { watch, retest: false }
  const retests = watch.retests + 1
  return {
    watch: { retests, dueAt: nowMs + retestWait(retests, schedule), lastRetestAt: nowMs },
    retest: true,
  }
}
