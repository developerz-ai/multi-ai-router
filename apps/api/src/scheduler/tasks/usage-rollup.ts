import type { UsageHistoryRepository } from "@multi-ai-router/db"
import type { ScheduledTask } from "../types"

export interface UsageRollupDeps {
  readonly history: Pick<UsageHistoryRepository, "backfill">
  readonly intervalMs: number
  readonly batchSize: number
}

/** Register pending retained legacy facts in bounded atomic batches; never reroll aging raw days. */
export function createUsageRollupTask(deps: UsageRollupDeps): ScheduledTask {
  return {
    name: "usage_rollup",
    intervalMs: deps.intervalMs,
    run: async ({ logger, signal }) => {
      let processed = 0
      let remaining = true
      while (remaining && !signal.aborted) {
        const batch = await deps.history.backfill({ limit: deps.batchSize })
        processed += batch.processed
        remaining = batch.remaining
        // No progress with more pending work must yield, rather than busy-loop on locked rows.
        if (remaining && batch.processed === 0) break
      }
      const outcome = remaining ? "partial" : "success"
      if (processed > 0 || remaining)
        logger.info("usage history registration", { outcome, processed })
      return { outcome, itemsProcessed: processed }
    },
  }
}
