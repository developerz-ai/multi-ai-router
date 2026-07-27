import type { UsageRecordRepository } from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { Logger } from "../../logging/logger"
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
 * one, says the same thing without becoming the incident.
 */

export interface UsageRecorderFromEnvDeps {
  readonly records: Pick<UsageRecordRepository, "insertMany">
  /** Only the queue's own three knobs: this module has no business reading the rest of the env. */
  readonly env: {
    readonly dataPlane: Pick<
      Env["dataPlane"],
      "usageQueueMax" | "usageBatchSize" | "usageFlushIntervalMs"
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
}

/**
 * How often a sustained drop or write failure is allowed to speak. A log-throttle window, not an
 * operational one: no retention, TTL, or sweep cadence depends on it.
 */
const REPORT_INTERVAL_MS = 60_000

export function createUsageRecorderFromEnv(deps: UsageRecorderFromEnvDeps): UsageRecorder {
  const log = deps.logger.child({ component: "usage" })
  const now = deps.now ?? (() => Date.now())
  const { usageQueueMax, usageBatchSize, usageFlushIntervalMs } = deps.env.dataPlane

  const reportShed = throttled<void>(now, (dropped) => {
    log.warn("usage records dropped on queue overflow", { dropped, queueMax: usageQueueMax })
  })
  const reportRetry = throttled<WriteFailure>(now, (batches, latest) => {
    log.warn("usage batch write failed — retrying it on the next flush, traffic unaffected", {
      batches,
      records: latest.size,
      reason: latest.reason,
    })
  })
  const reportDiscard = throttled<WriteFailure>(now, (batches, latest) => {
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
      ...(deps.onRecord === undefined ? {} : { onRecord: deps.onRecord }),
    },
  )
}

interface WriteFailure {
  readonly reason: string
  readonly size: number
}

/**
 * Ceiling on how much of a rejection's message is quoted. A driver names the statement it refused,
 * and a batch's statement is thousands of bind parameters long: unbounded, the one line an operator
 * needs to read becomes the reason they cannot read any of them.
 */
const MAX_REASON_CHARS = 200

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= MAX_REASON_CHARS ? message : `${message.slice(0, MAX_REASON_CHARS)}…`
}

/**
 * Emits at most once per {@link REPORT_INTERVAL_MS}, with how many events arrived since the last
 * emission and the most recent one's detail. The first event always speaks: an operator learns
 * about a drop when it starts, not a minute later.
 */
function throttled<T>(
  now: () => number,
  emit: (count: number, latest: T) => void,
): (value: T) => void {
  let count = 0
  let lastMs: number | null = null
  return (value) => {
    count += 1
    const at = now()
    if (lastMs !== null && at - lastMs < REPORT_INTERVAL_MS) return
    lastMs = at
    emit(count, value)
    count = 0
  }
}
