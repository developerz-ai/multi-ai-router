import { createWriterLifecycle } from "../shutdown/writer-lifecycle"
import { createBoundedQueue } from "./queue"
import type { UsageRecord } from "./record"
import {
  DEFAULT_USAGE_BATCH_SIZE,
  DEFAULT_USAGE_FLUSH_INTERVAL_MS,
  DEFAULT_USAGE_QUEUE_MAX,
  DEFAULT_USAGE_RETRY_BUFFER_MAX,
  type UsageRecorder,
  type UsageRecorderOptions,
  type UsageWriter,
} from "./recorder-types"
import type { UsageRequestTerminal } from "./request-terminal"

export * from "./recorder-types"

type QueuedUsage = UsageRecord | UsageRequestTerminal
const isAttempt = (event: QueuedUsage): event is UsageRecord => "eventId" in event

/**
 * Usage accounting, off the request path.
 *
 * `record()` is synchronous, allocation-light, never throws, and never awaits: it appends to a
 * bounded queue and returns. A background timer drains that queue in batches and hands them to an
 * injected {@link UsageWriter}. A request never waits on an insert, never opens a transaction, and
 * never fails because the database is slow — docs/idea/01-architecture.md, performance budget.
 *
 * A refused batch is held and retried, and the writer says why it was refused
 * ({@link UsageWriter.isTransient}):
 *
 * - **Transient** — the database is restarting, failing over, out of connections. The batch is kept
 *   and retried on every flush with no attempt cap, and each refused flush also moves one batch from
 *   the live queue into the retry buffer, so an outage holds up to `maxQueued + retryBufferMax`
 *   records. At the buffer's ceiling the *oldest* held records are dropped and counted as discarded
 *   (`onRetryOverflow`) — an outage outlasting the buffer loses its oldest records, never its newest.
 * - **Not transient** (or unclassified) — a row the writer rejects, a statement past a bind ceiling.
 *   One retry on the next flush, then the batch is bisected down to single rows and only the rows
 *   that still fail are discarded, so one poison row costs one record rather than its batch.
 *
 * Every refusal and every discard is counted (`router_usage_write_failures_total`) rather than
 * whispered into a log line nobody is tailing, and the pass always ends at the first refusal.
 *
 * The writer is a dependency rather than a database handle for two reasons: `packages/db` owns
 * SQL (a repository, not a service, issues the insert), and every test here runs against an array.
 */

export function createUsageRecorder(
  writer: UsageWriter,
  options: UsageRecorderOptions = {},
): UsageRecorder {
  const queue = createBoundedQueue<QueuedUsage>(options.maxQueued ?? DEFAULT_USAGE_QUEUE_MAX)
  const batchSize = options.batchSize ?? DEFAULT_USAGE_BATCH_SIZE
  const intervalMs = options.flushIntervalMs ?? DEFAULT_USAGE_FLUSH_INTERVAL_MS

  const retryBufferMax = options.retryBufferMax ?? DEFAULT_USAGE_RETRY_BUFFER_MAX
  const observe = options.onRecord

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let rejectedAfterStop = 0
  let unsettled = 0
  let written = 0
  let writeFailures = 0
  let writeDiscarded = 0
  /**
   * Refused records, oldest first, drained ahead of the queue. Held here rather than pushed onto
   * the queue's head so that queue overflow — which sheds the oldest, and these *are* the oldest —
   * cannot delete them; this buffer has its own ceiling and its own drop accounting.
   */
  let held: QueuedUsage[] = []
  /** The head batch was refused once for a reason that may be permanent; next refusal bisects. */
  let suspect = false

  const split = (batch: readonly QueuedUsage[]) => ({
    attempts: batch.filter(isAttempt),
    terminals: batch.filter((event): event is UsageRequestTerminal => !isAttempt(event)),
  })

  const transient = (error: unknown): boolean => {
    try {
      return writer.isTransient?.(error) ?? false
    } catch {
      return false
    }
  }

  /** Queue → buffer, observed exactly once: a retried record is never re-fed to the metrics. */
  const takeFromQueue = (): QueuedUsage[] => {
    const batch = queue.drain(batchSize)
    if (observe !== undefined) for (const event of batch) if (isAttempt(event)) observe(event)
    return batch
  }

  const hold = (records: readonly QueuedUsage[], atHead: boolean): void => {
    held = atHead ? [...records, ...held] : [...held, ...records]
    const excess = held.length - retryBufferMax
    if (excess <= 0) return
    held = held.slice(excess)
    writeFailures += excess
    writeDiscarded += excess
    options.onRetryOverflow?.(excess)
  }

  const write = async (batch: readonly QueuedUsage[]): Promise<void> => {
    const { attempts, terminals } = split(batch)
    unsettled = batch.length
    try {
      await writer.write(attempts, terminals)
      written += batch.length
    } finally {
      unsettled = 0
    }
  }

  /**
   * Halves a batch the writer has already refused twice down to single rows and discards only what
   * still fails. Returns the records it could not settle because the database went away mid-way.
   */
  const isolate = async (
    batch: readonly QueuedUsage[],
    lost: QueuedUsage[],
  ): Promise<readonly QueuedUsage[]> => {
    if (batch.length === 1) {
      lost.push(...batch)
      return []
    }
    const middle = Math.ceil(batch.length / 2)
    const left = await settle(batch.slice(0, middle), lost)
    if (left.length > 0) return [...left, ...batch.slice(middle)]
    return settle(batch.slice(middle), lost)
  }

  const settle = async (
    batch: readonly QueuedUsage[],
    lost: QueuedUsage[],
  ): Promise<readonly QueuedUsage[]> => {
    try {
      await write(batch)
      return []
    } catch (error) {
      return transient(error) ? batch : isolate(batch, lost)
    }
  }

  /** Returns false when the pass should end: the writer just refused, so the next batch would too. */
  const writeHead = async (
    batch: readonly QueuedUsage[],
    wasSuspect: boolean,
  ): Promise<boolean> => {
    try {
      await write(batch)
      return true
    } catch (error) {
      writeFailures += batch.length
      const { attempts, terminals } = split(batch)
      if (transient(error)) {
        hold(batch, true)
        // The outage is the database's, not this batch's: keep draining the live queue into the
        // retry buffer at the flush rate so the queue's own overflow never sheds newer records
        // while older ones are safe here.
        hold(takeFromQueue(), false)
        options.onWriteError?.({ error, batch: attempts, terminals, discarded: false })
        return false
      }
      if (!wasSuspect) {
        hold(batch, true)
        suspect = true
        options.onWriteError?.({ error, batch: attempts, terminals, discarded: false })
        return false
      }
      const lost: QueuedUsage[] = []
      const left = await isolate(batch, lost)
      if (left.length > 0) hold(left, true)
      if (lost.length > 0) {
        writeDiscarded += lost.length
        const dropped = split(lost)
        options.onWriteError?.({
          error,
          batch: dropped.attempts,
          terminals: dropped.terminals,
          discarded: true,
        })
      }
      return false
    }
  }

  const drainAll = async (): Promise<void> => {
    for (;;) {
      if (!lifecycle.canWrite()) return
      const fromHeld = held.length > 0
      const batch = fromHeld ? held.splice(0, batchSize) : takeFromQueue()
      if (batch.length === 0) return
      const wasSuspect = fromHeld && suspect
      suspect = false
      if (!(await writeHead(batch, wasSuspect))) return
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

  const lifecycle = createWriterLifecycle({
    flush,
    pending: () => queue.depth + held.length,
    outstanding: () => queue.depth + held.length + unsettled,
    timeoutMs: options.shutdownDrainMs ?? 15_000,
    warn: (pending) => options.onAbandoned?.(pending),
  })

  const enqueue = (event: QueuedUsage): void => {
    if (!lifecycle.accepting()) {
      rejectedAfterStop += 1
      return
    }
    if (!queue.push(event)) options.onShed?.(event)
  }

  return {
    record: enqueue,
    recordTerminal: enqueue,

    flush,

    start() {
      if (!lifecycle.start()) return
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
      await lifecycle.stop()
    },

    stats: () => ({
      rejectedAfterStop,
      depth: queue.depth + held.length,
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
    recordTerminal: () => undefined,
    flush: () => Promise.resolve(),
    start: () => undefined,
    stop: () => Promise.resolve(),
    stats: () => ({
      rejectedAfterStop: 0,
      depth: 0,
      dropped: 0,
      written: 0,
      writeFailures: 0,
      writeDiscarded: 0,
    }),
  }
}
