import type { UsageHistoryRepository } from "@multi-ai-router/db"
import type { ScheduledTask } from "../types"

export interface UsageRollupDeps {
  readonly history: Pick<UsageHistoryRepository, "backfill">
  readonly intervalMs: number
  readonly batchSize: number
  /**
   * `USAGE_BACKFILL_FULL_SCAN_HOURS`, in ms: how often a pass starts at the table's first row
   * instead of the banked watermark, to adopt rows a lock-free pre-2.16 writer landed below it.
   * Absent: never. Tracked per process — a restart runs one sooner, which is only extra reading.
   */
  readonly fullScanEveryMs?: number
}

/** Register pending retained legacy facts in bounded atomic batches; never reroll aging raw days. */
export function createUsageRollupTask(deps: UsageRollupDeps): ScheduledTask {
  let lastFullScanAt: number | undefined

  return {
    name: "usage_rollup",
    intervalMs: deps.intervalMs,
    run: async ({ now, logger, signal }) => {
      const fullScan =
        deps.fullScanEveryMs !== undefined &&
        (lastFullScanAt === undefined || now.getTime() - lastFullScanAt >= deps.fullScanEveryMs)
      let processed = 0
      let remaining = true
      while (remaining && !signal.aborted) {
        const batch = await deps.history.backfill({
          limit: deps.batchSize,
          ...(fullScan ? { fullScan: true } : {}),
        })
        processed += batch.processed
        remaining = batch.remaining
        // No progress with more pending work must yield, rather than busy-loop on locked rows.
        if (remaining && batch.processed === 0) break
      }
      // Only a full scan that reached the end counts; an interrupted one resumes next tick.
      if (fullScan && !remaining) lastFullScanAt = now.getTime()
      const outcome = remaining ? "partial" : "success"
      if (processed > 0 || remaining)
        logger.info("usage history registration", { outcome, processed, fullScan })
      return { outcome, itemsProcessed: processed }
    },
  }
}
