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
 * A refused batch gets **one** more try, on the next flush. A database is unavailable for a second
 * far more often than it is unavailable permanently, and a batch thrown away on the first rejection
 * turns a blip into deleted rows. One retry is the whole ladder: a batch the writer will never
 * accept — a row it rejects, a statement past a bind ceiling — would otherwise sit at the head of
 * the queue forever and starve every record behind it. So it is retried once, then discarded, and
 * both the retry and the discard are counted (`router_usage_write_failures_total`) rather than
 * whispered into a log line nobody is tailing.
 *
 * The writer is a dependency rather than a database handle for two reasons: `packages/db` owns
 * SQL (a repository, not a service, issues the insert), and every test here runs against an array.
 */

export interface UsageWriter {
  /** Persists one batch. May reject; the recorder retries it once, then counts it and moves on. */
  write(batch: readonly UsageRecord[]): Promise<void>
}

/** What `onWriteError` is handed: the rejection, the records it refused, and their fate. */
export interface UsageWriteFailure {
  readonly error: unknown
  readonly batch: readonly UsageRecord[]
  /**
   * False when the batch went back for its one retry — reporting is late, nothing is lost yet.
   * True when that retry was refused too and the records were dropped. The two are different
   * incidents and read differently: one is a blip, the other is data loss.
   */
  readonly discarded: boolean
}

export interface UsageRecorderOptions {
  /**
   * Queue ceiling. On overflow the oldest records are shed — reporting degrades, traffic does not.
   * A batch awaiting its retry is held beside the queue rather than in it, so peak memory is
   * `maxQueued + batchSize` records: a full queue must not shed the one batch already in hand.
   */
  readonly maxQueued?: number
  readonly batchSize?: number
  readonly flushIntervalMs?: number
  /** Called once per shed record, so the drop counter and the warn log have a source. */
  readonly onShed?: (record: UsageRecord) => void
  /** Called once per refused batch — twice for one that fails, retries, and fails again. */
  readonly onWriteError?: (failure: UsageWriteFailure) => void
  /**
   * Called at most once, from `stop()`, with how many records were still unwritten when shutdown
   * gave up on them — a retry batch the writer refused again, and the queue behind it. Invisible
   * loss is the one thing this module promises not to do, and records that die with the process
   * must be counted like records shed or discarded, not merely absent.
   */
  readonly onAbandoned?: (records: number) => void
  /**
   * Called once per record as the batch drains — which is to say on the flush timer, never on
   * the request path. This is where metrics are fed from: an observation costs a map lookup and
   * an add, and even that belongs off the critical path (CLAUDE.md non-negotiable 8).
   *
   * Called whether or not the write succeeds: the record is a fact about what the router did,
   * and a database that rejected the row does not un-do the attempt it describes. Exactly once
   * per record, though — a retried batch is not re-observed, or a blip in Postgres would show up
   * on the dashboard as upstream attempts the router never made. It must not throw; one that does
   * would take a batch's remaining records with it.
   */
  readonly onRecord?: (record: UsageRecord) => void
}

/** Defaults, all overridable: no retention window, interval, or limit is a constant in code. */
export const DEFAULT_USAGE_QUEUE_MAX = 10_000
export const DEFAULT_USAGE_BATCH_SIZE = 200
export const DEFAULT_USAGE_FLUSH_INTERVAL_MS = 1_000

export interface UsageStats {
  /** Queued records, the batch waiting for its retry included. */
  readonly depth: number
  readonly dropped: number
  readonly written: number
  /** Records the writer refused. Counts both tries of a batch that failed twice. */
  readonly writeFailures: number
  /** The subset of the above that was lost: a batch whose retry was refused as well. */
  readonly writeDiscarded: number
}

export interface UsageRecorder {
  /** Enqueue. Synchronous, non-throwing, off the critical path. */
  record(record: UsageRecord): void
  /**
   * Drains and writes everything queued, stopping at the first refused batch — the next one would
   * meet the same database. Used by tests and by graceful shutdown.
   */
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
  let writeDiscarded = 0
  /**
   * The batch a refused write handed back, drained ahead of the queue on the next pass. Held here
   * rather than pushed onto the queue's head so that overflow — which sheds the oldest, and these
   * *are* the oldest — cannot delete it before it gets the retry it is waiting for.
   */
  let retry: readonly UsageRecord[] | null = null

  /** Returns false when the pass should end: the writer just refused, so the next batch would too. */
  const writeBatch = async (batch: readonly UsageRecord[], retried: boolean): Promise<boolean> => {
    const observe = options.onRecord
    if (observe !== undefined && !retried) for (const record of batch) observe(record)
    try {
      await writer.write(batch)
      written += batch.length
      return true
    } catch (error) {
      writeFailures += batch.length
      // One retry, then gone: a batch the writer can never accept would otherwise come back
      // forever and starve every record behind it.
      if (retried) writeDiscarded += batch.length
      else retry = batch
      options.onWriteError?.({ error, batch, discarded: retried })
      return false
    }
  }

  const drainAll = async (): Promise<void> => {
    for (;;) {
      // Taken before the write so a failure can put it back — and so the retry lands on the *next*
      // pass, one flush interval later, rather than hitting the same unavailable database twice in
      // the same breath.
      const retried = retry
      retry = null
      const batch = retried ?? queue.drain(batchSize)
      if (batch.length === 0) return
      if (!(await writeBatch(batch, retried !== null))) return
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
      // The await above may have coalesced onto a pass whose final drain predates records
      // enqueued since — or ended early on a refused batch. One fresh pass writes what it can
      // (and gives a held retry batch its one try) instead of abandoning it all silently.
      if (queue.depth > 0 || retry !== null) await flush()
      const stranded = queue.depth + (retry?.length ?? 0)
      if (stranded > 0) options.onAbandoned?.(stranded)
    },

    stats: () => ({
      depth: queue.depth + (retry?.length ?? 0),
      dropped: queue.dropped,
      written,
      writeFailures,
      writeDiscarded,
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
    stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
  }
}
