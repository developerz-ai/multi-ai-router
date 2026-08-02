import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, UsageRecordRepository } from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { Logger } from "../../logging/logger"
import { redactValue } from "../../logging/redact"
import type { UsageRecord } from "./record"
import { toUsageRecordRow } from "./record"
import { createUsageRecorder, type UsageRecorder } from "./recorder"

/**
 * The one place the usage recorder becomes a *production* recorder: a repository behind the writer,
 * the queue's shape from env, and — the reason this module exists — a voice for the ways reporting
 * can fail quietly.
 *
 * `recorder.ts` stays a pure queue with hooks because every test there runs against an array. What
 * a running deployment adds is policy: a shed record is **data loss**, and data loss that only
 * shows up as a gauge nobody scrapes is data loss nobody notices. So three things speak, and they
 * speak at the level they deserve — a refused batch that is going back for its retry is a `warn`
 * (reporting is late), the same batch refused twice is an `error` (rows are gone).
 *
 * They log **throttled**, though, because the failure mode is a flood by definition: a queue that
 * overflows sheds thousands of records a second, and one line each would push the very logs an
 * operator needs to read out of the buffer. One line per window, carrying the count since the last
 * one, says the same thing without becoming the incident — and a burst that stops mid-window gets
 * a trailing report for its tail, so 500 sheds are never remembered as `dropped: 1`.
 */

/** Schedules the trailing throttle report. Injected only by tests. */
export type TrailingTimer = (fire: () => void, delayMs: number) => void

export interface UsageRecorderFromEnvDeps {
  readonly records: Pick<UsageRecordRepository, "insertMany">
  /**
   * Stamped once per flush with every account the batch touched, so "unused for a week" is an
   * indexed question about the account rather than a scan of a table retention prunes. Off the
   * request path by construction — this runs on the recorder's background drain.
   */
  readonly accounts: Pick<AccountRepository, "markUsed">
  /** Only the queue's and this module's own knobs: no business reading the rest of the env. */
  readonly env: {
    readonly logReasonMaxChars: number
    readonly dataPlane: Pick<
      Env["dataPlane"],
      "usageQueueMax" | "usageBatchSize" | "usageFlushIntervalMs" | "usageLogReportIntervalMs"
    >
  }
  readonly logger: Logger
  /**
   * Forwarded to the recorder's `onRecord`, which fires on the background drain. Metrics are fed
   * from there and never from the request path (CLAUDE.md non-negotiable 8).
   */
  readonly onRecord?: (record: UsageRecord) => void
  /** Monotonic-enough milliseconds for the log throttle. Injected only by tests. */
  readonly now?: () => number
  /** The wall clock the last-used stamp is written with. Injected only by tests. */
  readonly clock?: () => Date
  /** Trailing-report scheduling. Production uses an unref'd `setTimeout`; tests inject. */
  readonly timer?: TrailingTimer
}

/** The trailing report must never be the reason the process stays alive. */
const defaultTimer: TrailingTimer = (fire, delayMs) => {
  const timer = setTimeout(fire, delayMs)
  timer.unref?.()
}

export function createUsageRecorderFromEnv(deps: UsageRecorderFromEnvDeps): UsageRecorder {
  const clock = deps.clock ?? (() => new Date())
  const log = deps.logger.child({ component: "usage" })
  const now = deps.now ?? (() => Date.now())
  const timer = deps.timer ?? defaultTimer
  const { logReasonMaxChars } = deps.env
  const { usageQueueMax, usageBatchSize, usageFlushIntervalMs, usageLogReportIntervalMs } =
    deps.env.dataPlane

  /**
   * The full cause chain, innermost first (`describeError`): an ORM's wrapper message names the
   * *statement* it refused and carries the real complaint one `cause` down — logging only the
   * wrapper once hid a client-side bind failure behind its own statement text for days. Redacted
   * *before* the cap so truncation can never split a credential in half and leave the tail for
   * the logger's second pass to miss.
   */
  const reasonOf = (error: unknown): string => {
    const scrubbed = redactValue(describeError(error, Number.POSITIVE_INFINITY))
    return scrubbed.length <= logReasonMaxChars
      ? scrubbed
      : `${scrubbed.slice(0, logReasonMaxChars)}…`
  }

  const throttle = <T>(emit: (count: number, latest: T) => void): ((value: T) => void) =>
    throttled(now, usageLogReportIntervalMs, timer, emit)

  const reportShed = throttle<void>((dropped) => {
    log.warn("usage records dropped on queue overflow", { dropped, queueMax: usageQueueMax })
  })
  const reportRetry = throttle<WriteFailure>((batches, latest) => {
    log.warn("usage batch write failed — retrying it on the next flush, traffic unaffected", {
      batches,
      records: latest.size,
      reason: latest.reason,
    })
  })
  // Throttled like its neighbours: a database that refuses this refuses it every flush, and one
  // line per flush would bury the write failure that actually matters.
  const reportStampFailure = throttle<WriteFailure>((batches, latest) => {
    log.warn("usage written but last-used stamp failed — idle probing may run early", {
      batches,
      accounts: latest.size,
      reason: latest.reason,
    })
  })
  const reportDiscard = throttle<WriteFailure>((batches, latest) => {
    log.error("usage batch write failed twice — records lost, traffic unaffected", {
      batches,
      records: latest.size,
      reason: latest.reason,
    })
  })

  return createUsageRecorder(
    {
      write: async (batch) => {
        await deps.records.insertMany(batch.map(toUsageRecordRow))
        // One extra statement per *flush*, not per request, and strictly after the records land:
        // this stamp is what lets the idle probe find an account nothing has routed to in a week
        // without scanning a table retention prunes. A failure here must not cost the batch that
        // already succeeded — a missed stamp makes an account look idler than it is, which the
        // probe answers with one free auth check, while a re-thrown error would re-queue records
        // already written and double-count them.
        const used = batch.flatMap((entry) => (entry.accountId === null ? [] : [entry.accountId]))
        if (used.length === 0) return
        try {
          await deps.accounts.markUsed(used, clock())
        } catch (error) {
          reportStampFailure({ reason: reasonOf(error), size: used.length })
        }
      },
    },
    {
      maxQueued: usageQueueMax,
      batchSize: usageBatchSize,
      flushIntervalMs: usageFlushIntervalMs,
      onShed: () => reportShed(undefined),
      onWriteError: ({ error, batch, discarded }) => {
        const failure = { reason: reasonOf(error), size: batch.length }
        if (discarded) reportDiscard(failure)
        else reportRetry(failure)
      },
      // Unthrottled and at `error`: it fires at most once, at stop(), and it means rows are gone.
      onAbandoned: (records) => {
        log.error("usage records unwritten at shutdown — records lost", { records })
      },
      ...(deps.onRecord === undefined ? {} : { onRecord: deps.onRecord }),
    },
  )
}

interface WriteFailure {
  readonly reason: string
  readonly size: number
}

/**
 * Emits at most once per window, with how many events arrived since the last emission and the
 * most recent one's detail. The first event always speaks: an operator learns about a drop when
 * it starts, not a minute later. Events suppressed mid-window arm one trailing timer for the
 * window's end, so a burst that stops is still counted in full rather than remembered as the one
 * event that opened it.
 */
function throttled<T>(
  now: () => number,
  intervalMs: number,
  timer: TrailingTimer,
  emit: (count: number, latest: T) => void,
): (value: T) => void {
  let count = 0
  let latest: { readonly value: T } | null = null
  let lastMs: number | null = null
  let armed = false

  const fireTrailing = (): void => {
    armed = false
    if (count === 0 || latest === null) return
    lastMs = now()
    emit(count, latest.value)
    count = 0
  }

  return (value) => {
    count += 1
    latest = { value }
    const at = now()
    if (lastMs === null || at - lastMs >= intervalMs) {
      lastMs = at
      emit(count, value)
      count = 0
      return
    }
    if (!armed) {
      armed = true
      timer(fireTrailing, intervalMs - (at - lastMs))
    }
  }
}
