import type { ScheduledTask } from "../types"
import { runSweeps } from "./sweep"

/**
 * Sweeps expired admin console sessions out of the `SessionStore`
 * (`services/admin-auth/postgresSessionStore.ts` in the deployed shape).
 *
 * A table sweep like every other: `admin_sessions` is shared by every replica,
 * so this runs through `runSweeps` under the run's advisory lock and exactly
 * one replica drains it per tick, in bounded batches, resumable across
 * shutdown. It stays its own task rather than a janitor category because it is
 * on its own cadence (`ADMIN_SESSION_PURGE_INTERVAL_MINUTES`) and because it
 * goes through the store, not a repository: the store also evicts the dead
 * entries from its per-replica read cache, and only it knows that cache exists.
 *
 * **The cutoff is the tick's clock.** Both expiry bounds are already durable
 * instants on the row — `authenticate()` refuses a session the moment either
 * passes — so no retention window is applied here; the sweep only removes what
 * the auth path would already reject, freeing the row a never-revisited
 * session would otherwise hold forever.
 */

export interface AdminSessionStoreForPurge {
  /** Drops at most `limit` sessions past their own expiry. Returns how many; `limit` means more. */
  deleteExpired(nowMs: number, limit: number): Promise<number>
}

export interface AdminSessionPurgeDeps {
  readonly sessions: AdminSessionStoreForPurge
  /** `ADMIN_SESSION_PURGE_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `SWEEP_BATCH_SIZE`. */
  readonly batchSize: number
}

export function createAdminSessionPurgeTask(deps: AdminSessionPurgeDeps): ScheduledTask {
  return {
    name: "admin_session_purge",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const report = await runSweeps(
        [
          {
            category: "adminSessions",
            deleteBatch: (limit) => deps.sessions.deleteExpired(now.getTime(), limit),
          },
        ],
        { batchSize: deps.batchSize, signal },
      )

      logger.info("admin session purge", {
        outcome: report.outcome,
        deleted: report.itemsProcessed,
      })
      return report
    },
  }
}
