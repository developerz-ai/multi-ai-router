import { describeError } from "@multi-ai-router/core"
import type { TaskOutcome } from "../types"

/**
 * The bounded-batch drain every retention task is built from.
 *
 * Written once here because the janitor and the OAuth-state purge delete on
 * exactly the same terms and differ only in which tables they name. The three
 * properties the spec demands of a sweep (docs/idea/09-deployment.md, "Janitor
 * rules") all live in this loop rather than in each task:
 *
 * - **Bounded batches, never one giant statement.** A 90-day purge in a single
 *   `DELETE` bloats the WAL, holds row locks across the whole range, and gives
 *   autovacuum nothing to reclaim until it commits. The data plane must not feel
 *   a sweep, so each batch is its own small statement and the loop yields
 *   between them.
 * - **Drains rather than nibbles.** One batch per tick would be a throughput
 *   ceiling, not a safety bound: a router writing usage rows faster than
 *   `SWEEP_BATCH_SIZE` per interval would never catch up and the table would
 *   grow forever. The loop keeps going until a batch comes back short, which is
 *   how it learns the category is caught up.
 * - **Resumable, so shutdown is prompt.** The abort signal is checked between
 *   batches — never mid-statement — and a run that stops with a full batch
 *   behind it reports `partial`: not a failure, just "there is more, and the
 *   next tick continues where this one stopped".
 *
 * Nothing here decides *how old is old*. Every cutoff is computed by the caller
 * from `env.retention` (CLAUDE.md non-negotiable 11); this loop is handed
 * closures that already know theirs.
 */

/** One category of aged rows, and the statement that deletes a batch of them. */
export interface Sweep {
  /** Identifies the category in the run's summary log line. */
  readonly category: string
  /**
   * Deletes one bounded batch, oldest first, and returns how many went. Fewer
   * than `limit` means this category is caught up.
   */
  deleteBatch(limit: number): Promise<number>
}

export interface SweepOptions {
  /** `SWEEP_BATCH_SIZE`. Rows per statement, never per run. */
  readonly batchSize: number
  /** The runner's shutdown signal, checked between batches. */
  readonly signal: AbortSignal
}

/** A {@link TaskOutcome} the task can return as-is, plus the per-category breakdown it logs. */
export interface SweepReport extends TaskOutcome {
  /** Deleted rows per category, in sweep order. Zero-valued entries are kept: "swept, found nothing". */
  readonly counts: Readonly<Record<string, number>>
}

/** Drains each category in turn and reports what went, in total and per category. */
export async function runSweeps(
  sweeps: readonly Sweep[],
  options: SweepOptions,
): Promise<SweepReport> {
  const counts: Record<string, number> = {}
  let deleted = 0
  let remaining = false

  const record = (category: string, batch: number): void => {
    counts[category] = (counts[category] ?? 0) + batch
    deleted += batch
  }

  try {
    for (const sweep of sweeps) {
      if (options.signal.aborted) {
        remaining = true
        break
      }
      counts[sweep.category] = 0
      for (;;) {
        const batch = await sweep.deleteBatch(options.batchSize)
        record(sweep.category, batch)
        // Short batch: this category is drained. Full batch: there is more, so
        // keep going unless shutdown has asked us to stop.
        if (batch < options.batchSize) break
        if (options.signal.aborted) {
          remaining = true
          break
        }
      }
      if (remaining) break
    }
  } catch (error) {
    // Caught rather than thrown so the count survives: the batches that already
    // committed are deleted whatever happens next, and a run that reports zero
    // reads as "did nothing" to the operator. The runner redacts and truncates
    // the message before it reaches `scheduled_task_runs.error`.
    // The full cause chain, unbounded here on purpose: the runner redacts and truncates once,
    // and a pre-cut could split a credential right where its scrub would have matched.
    return {
      outcome: "failed",
      itemsProcessed: deleted,
      error: describeError(error, Number.POSITIVE_INFINITY),
      counts,
    }
  }

  return { outcome: remaining ? "partial" : "success", itemsProcessed: deleted, counts }
}
