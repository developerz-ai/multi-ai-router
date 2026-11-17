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
 * `tickMs` includes the jittered timer plus the bounded work after an early re-test and before a
 * late successor re-test. {@link retestWaitCapMs} leaves that full span under the cap, so actual
 * re-test-to-re-test gaps never exceed `maxMs`, whichever accounts the task processes first or last.
 */

export interface ExhaustedRetestSchedule {
  /** `EXHAUSTED_RECHECK_FIRST_MINUTES`: the wait before the first re-test, and the base it doubles. */
  readonly firstMs: number
  /** `EXHAUSTED_RECHECK_MAX_MINUTES`: the longest an `exhausted` account goes without a re-test. */
  readonly maxMs: number
  /**
   * The worst-case gap between actual re-tests: the runner's jittered interval plus bounded work
   * after an early re-test and before a late successor re-test ({@link worstCaseTickMs}). The
   * scheduled wait must leave this much room under `maxMs`, because only a tick fires a re-test.
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
 * The largest gap between actual re-tests: the runner's jittered timer plus two bounded task runs.
 * The first run may re-test an account before its remaining work; the runner then arms the timer,
 * and the successor can re-test a different account at the end of its run.
 */
export function worstCaseTickMs(
  intervalMs: number,
  jitterFraction: number,
  taskMaxRunMs = 0,
): number {
  return Math.round(intervalMs * (1 + jitterFraction)) + 2 * taskMaxRunMs
}

/**
 * The longest wait the ladder may schedule: `maxMs` less one worst-case tick, floored at `firstMs`
 * so a cap narrower than the first wait cannot invert the ladder.
 */
export function retestWaitCapMs(schedule: ExhaustedRetestSchedule): number {
  return Math.max(schedule.firstMs, schedule.maxMs - schedule.tickMs)
}

/**
 * The maximum re-test-to-re-test span: the capped wait plus one worst-case timer-and-two-runs span.
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
