import { createBoundedQueue } from "./queue"
import type { UsageRecord } from "./record"

/**
 * Usage accounting, off the request path.
 *
 * `record()` is synchronous, allocation-light, never throws, and never awaits: it appends to a
 * bounded queue and returns. A background timer drains that queue in batches and hands them to an
 * injected {@link UsageWriter}. A request never waits on an insert, never opens a transaction, and
 * never fails because the database is slow — docs/idea/01-architecture.md, performance budget.
 *
 * The writer is a dependency rather than a database handle for two reasons: `packages/db` owns
 * SQL (a repository, not a service, issues the insert), and every test here runs against an array.
 */

export interface UsageWriter {
  /** Persists one batch. May reject; the recorder counts the failure and moves on. */
  write(batch: readonly UsageRecord[]): Promise<void>
}

export interface UsageRecorderOptions {
  /** Queue ceiling. On overflow the oldest records are shed — reporting degrades, traffic does not. */
  readonly maxQueued?: number
  readonly batchSize?: number
  readonly flushIntervalMs?: number
  /** Called once per shed record, so the drop counter and the warn log have a source. */
  readonly onShed?: (record: UsageRecord) => void
  readonly onWriteError?: (error: unknown, batch: readonly UsageRecord[]) => void
  /**
   * Called once per record as the batch drains — which is to say on the flush timer, never on
   * the request path. This is where metrics are fed from: an observation costs a map lookup and
   * an add, and even that belongs off the critical path (CLAUDE.md non-negotiable 8).
   *
   * Called whether or not the write succeeds: the record is a fact about what the router did,
   * and a database that rejected the row does not un-do the attempt it describes. It must not
   * throw; one that does would take a batch's remaining records with it.
   */
  readonly onRecord?: (record: UsageRecord) => void
}

/** Defaults, all overridable: no retention window, interval, or limit is a constant in code. */
export const DEFAULT_USAGE_QUEUE_MAX = 10_000
export const DEFAULT_USAGE_BATCH_SIZE = 200
export const DEFAULT_USAGE_FLUSH_INTERVAL_MS = 1_000

export interface UsageStats {
  readonly depth: number
  readonly dropped: number
  readonly written: number
  readonly writeFailures: number
}

export interface UsageRecorder {
  /** Enqueue. Synchronous, non-throwing, off the critical path. */
  record(record: UsageRecord): void
  /** Drains and writes everything queued. Used by tests and by graceful shutdown. */
  flush(): Promise<void>
  start(): void
  /** Stops the timer and flushes what is left. */
  stop(): Promise<void>
  stats(): UsageStats
}

export function createUsageRecorder(
  writer: UsageWriter,
  options: UsageRecorderOptions = {},
): UsageRecorder {
  const queue = createBoundedQueue<UsageRecord>(options.maxQueued ?? DEFAULT_USAGE_QUEUE_MAX)
  const batchSize = options.batchSize ?? DEFAULT_USAGE_BATCH_SIZE
  const intervalMs = options.flushIntervalMs ?? DEFAULT_USAGE_FLUSH_INTERVAL_MS

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let written = 0
  let writeFailures = 0

  const writeBatch = async (batch: readonly UsageRecord[]): Promise<void> => {
    const observe = options.onRecord
    if (observe !== undefined) for (const record of batch) observe(record)
    try {
      await writer.write(batch)
      written += batch.length
    } catch (error) {
      // Deliberately not re-queued: a batch the writer cannot accept would otherwise loop
      // forever at the head of the queue and starve every record behind it.
      writeFailures += batch.length
      options.onWriteError?.(error, batch)
    }
  }

  const drainAll = async (): Promise<void> => {
    for (let batch = queue.drain(batchSize); batch.length > 0; batch = queue.drain(batchSize)) {
      await writeBatch(batch)
    }
  }

  /** One drain at a time: a slow writer must not have two batches racing into the same table. */
  const flush = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    const run = drainAll().finally(() => {
      inFlight = null
    })
    inFlight = run
    return run
  }

  return {
    record(record) {
      if (!queue.push(record)) options.onShed?.(record)
    },

    flush,

    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        void flush()
      }, intervalMs)
      // The writer must never be the reason the process stays alive.
      timer.unref?.()
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      await flush()
    },

    stats: () => ({
      depth: queue.depth,
      dropped: queue.dropped,
      written,
      writeFailures,
    }),
  }
}

/** A recorder that keeps nothing. For boot before the writer exists, and for unit tests. */
export function createNullUsageRecorder(): UsageRecorder {
  return {
    record: () => undefined,
    flush: () => Promise.resolve(),
    start: () => undefined,
    stop: () => Promise.resolve(),
    stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0 }),
  }
}
