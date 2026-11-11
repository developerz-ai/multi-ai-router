import type { UsageRecord } from "./record"
import type { UsageRequestTerminal } from "./request-terminal"

type QueuedUsage = UsageRecord | UsageRequestTerminal

/** The recorder's contract: its writer port, options, and stats. Behaviour lives in `recorder.ts`. */

export interface UsageWriter {
  /** Persists one batch. May reject; see the module header for what happens to it then. */
  write(batch: readonly UsageRecord[], terminals?: readonly UsageRequestTerminal[]): Promise<void>
  /**
   * True when the refusal says the *database* is unavailable rather than that this batch is
   * unwritable — then the batch is retried for as long as the outage lasts. Absent: every refusal
   * is treated as possibly permanent (one retry, then bisect).
   */
  isTransient?(error: unknown): boolean
}

/** What `onWriteError` is handed: the rejection, the records it refused, and their fate. */
export interface UsageWriteFailure {
  readonly error: unknown
  readonly batch: readonly UsageRecord[]
  readonly terminals: readonly UsageRequestTerminal[]
  /**
   * False when the batch went back to be retried — reporting is late, nothing is lost yet. True
   * when the records in `batch`/`terminals` were dropped: the rows a bisected batch still could not
   * write. The two are different incidents and read differently: one is a blip, the other is data
   * loss.
   */
  readonly discarded: boolean
}

export interface UsageRecorderOptions {
  readonly shutdownDrainMs?: number
  /**
   * Queue ceiling. On overflow the oldest records are shed — reporting degrades, traffic does not.
   * A batch awaiting its retry is held beside the queue rather than in it, so peak memory is
   * `maxQueued + batchSize` records: a full queue must not shed the one batch already in hand.
   */
  readonly maxQueued?: number
  readonly batchSize?: number
  readonly flushIntervalMs?: number
  /**
   * Records a transient outage may hold for retry beside the live queue (`USAGE_RETRY_BUFFER_MAX`).
   * Past it the oldest held records are dropped, counted as discarded, and reported through
   * `onRetryOverflow`.
   */
  readonly retryBufferMax?: number
  /** Called once per overflow with how many of the oldest held records were dropped. */
  readonly onRetryOverflow?: (records: number) => void
  /** Called once per shed record, so the drop counter and the warn log have a source. */
  readonly onShed?: (record: QueuedUsage) => void
  /** Called once per refused batch, and once more with what a bisected batch finally lost. */
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
export const DEFAULT_USAGE_RETRY_BUFFER_MAX = 10_000

export interface UsageStats {
  readonly rejectedAfterStop: number
  /** Queued records, the batch waiting for its retry included. */
  readonly depth: number
  readonly dropped: number
  readonly written: number
  /**
   * Records the writer refused, once per refused write, plus records dropped from a full retry
   * buffer — so `writeFailures - writeDiscarded` never decreases.
   */
  readonly writeFailures: number
  /** The subset of the above that was lost: rows a bisect could not write, and retry overflow. */
  readonly writeDiscarded: number
}

export interface UsageRecorder {
  /** Enqueue. Synchronous, non-throwing, off the critical path. */
  record(record: UsageRecord): void
  recordTerminal(terminal: UsageRequestTerminal): void
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
