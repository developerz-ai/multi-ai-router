import type { OauthStateRepository } from "@multi-ai-router/db"
import type { ScheduledTask } from "../types"
import { runSweeps } from "./sweep"

/**
 * The one-shot OAuth `state` + PKCE verifier purge.
 *
 * Its own task rather than a fifth category inside the janitor, and on its own
 * cadence — minutes, against the janitor's hours (docs/idea/08-observability.md,
 * "Scheduled task visibility"). The reason is what the rows contain: an
 * AES-256-GCM envelope of a `code_verifier`. A retention window measured in
 * hours would mean an expired secret sitting in the database long after it could
 * possibly be useful, which is the one thing a table of one-shot values must not
 * do.
 *
 * **The cutoff is the tick's clock, not `now - RETENTION_OAUTH_STATE_MINUTES`.**
 * `oauth_states.expires_at` is that window already made durable — the service
 * that mints a state stamps `expires_at = now + oauthStateMinutes` — so
 * subtracting it a second time here would keep every verifier for twice its
 * configured TTL. Nothing in this file is a constant either way: the window is
 * config, applied once, at the only place that can apply it.
 *
 * Rows are purged strictly *after* they expire, never before. Until `expires_at`
 * passes, a consumed row is the record that turns a replayed `state` into a
 * rejection rather than a miss (`OauthStateRepository.consume`), so deleting one
 * early would reopen exactly the window the table exists to close.
 */

export interface OauthPurgeDeps {
  readonly oauthStates: Pick<OauthStateRepository, "deleteExpiredBefore">
  /** `OAUTH_STATE_PURGE_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `SWEEP_BATCH_SIZE`. */
  readonly batchSize: number
}

export function createOauthPurgeTask(deps: OauthPurgeDeps): ScheduledTask {
  return {
    name: "oauth_state_purge",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const report = await runSweeps(
        [
          {
            category: "oauthStates",
            deleteBatch: (limit) => deps.oauthStates.deleteExpiredBefore(now, limit),
          },
        ],
        { batchSize: deps.batchSize, signal },
      )

      logger.info("oauth state purge", {
        outcome: report.outcome,
        deleted: report.itemsProcessed,
      })
      return report
    },
  }
}
