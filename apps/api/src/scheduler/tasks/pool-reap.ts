import { describeError } from "@multi-ai-router/core"
import type { PoolRepository } from "@multi-ai-router/db"
import type { PoolReaper } from "../../services/pools"
import type { ScheduledTask, TaskOutcome } from "../types"

/**
 * The empty-pool reap: deletes a pool that has had no member for `RETENTION_EMPTY_POOL_DAYS`, and
 * revokes the keys that then reach nothing (`services/pools/reaper.ts` decides each key's fate).
 *
 * **The clock is `pools.empty_since`**, kept by a trigger on `pool_members` so an account deletion
 * that cascades away a pool's last member starts it too. The candidate read is advisory; each
 * pool is re-checked under its row lock, so a member added since is never reaped. Idempotent: a
 * pool already gone is a skip. Bounded: at most `SWEEP_BATCH_SIZE` pools a tick, longest-empty
 * first, and `partial` when more are due.
 *
 * **Every deletion and revocation is an alert.** The two warn lines below are what an alert rule
 * matches on (docs/idea/08-observability.md): a reaped pool is configuration that disappeared, and
 * a revoked key is a client that will start failing `401`.
 */

export interface PoolReapDeps {
  readonly pools: Pick<PoolRepository, "listEmptySince">
  readonly reaper: PoolReaper
  /** `RETENTION_EMPTY_POOL_DAYS`, in milliseconds. */
  readonly windowMs: number
  /** `POOL_REAP_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `SWEEP_BATCH_SIZE`, counted in pools. */
  readonly batchSize: number
}

/** What the composition root hands in; the rest is config. */
export type PoolReapPorts = Pick<PoolReapDeps, "pools" | "reaper">

/** No ports, no task: a deployment with nothing wired gets none rather than one that ticks idle. */
export function createPoolReapTasks(
  ports: PoolReapPorts | undefined,
  options: Omit<PoolReapDeps, keyof PoolReapPorts>,
): readonly ScheduledTask[] {
  return ports === undefined ? [] : [createPoolReapTask({ ...ports, ...options })]
}

export function createPoolReapTask(deps: PoolReapDeps): ScheduledTask {
  return {
    name: "pool_reap",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }): Promise<TaskOutcome> => {
      const cutoff = new Date(now.getTime() - deps.windowMs)
      // One past the batch, so "more are due" is known without a second query.
      const due = await deps.pools.listEmptySince(cutoff, deps.batchSize + 1)
      const batch = due.slice(0, deps.batchSize)

      let reaped = 0
      let revoked = 0
      let stopped = false
      try {
        for (const pool of batch) {
          if (signal.aborted) {
            stopped = true
            break
          }
          const outcome = await deps.reaper.reap(pool.id, cutoff)
          if (outcome.kind === "skipped") continue
          reaped += 1
          revoked += outcome.revokedKeyIds.length
          logger.warn("empty pool reaped", {
            poolId: outcome.poolId,
            poolName: outcome.poolName,
            emptySince: outcome.emptySince.toISOString(),
            revokedKeyIds: outcome.revokedKeyIds,
            detachedKeyIds: outcome.detachedKeyIds,
          })
          for (const keyId of outcome.revokedKeyIds) {
            logger.warn("key revoked: every pool it was scoped to was reaped", {
              keyId,
              poolId: outcome.poolId,
            })
          }
        }
      } catch (error) {
        // Caught so the count survives: what was reaped is committed whatever happens next.
        return {
          outcome: "failed",
          itemsProcessed: reaped,
          error: describeError(error, Number.POSITIVE_INFINITY),
        }
      }

      logger.info("empty pool reap", { due: batch.length, reaped, revokedKeys: revoked })
      return {
        outcome: stopped || due.length > deps.batchSize ? "partial" : "success",
        itemsProcessed: reaped,
      }
    },
  }
}
