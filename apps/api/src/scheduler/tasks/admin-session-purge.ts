import type { ScheduledTask } from "../types"

/**
 * Sweeps expired admin console sessions out of the in-memory `SessionStore`
 * (`services/admin-auth/sessionStore.ts`).
 *
 * **Its own task, not a fifth janitor category.** The janitor's four categories
 * are all Postgres tables, drained through `runSweeps` under the run's advisory
 * lock so exactly one replica does the work. This store is neither: it is a
 * `Map` living in *this* process's heap, so there is nothing to coordinate and
 * nothing another replica could double-delete. Folding it into the janitor
 * would buy a shared cadence at the cost of implying a shared resource that
 * does not exist.
 *
 * **Every replica sweeps its own store.** The lock still wraps this task like
 * every other — `docs/idea/01-architecture.md`'s "no broker" is about the
 * *mechanism* (in-process timers, not a queue), not about serializing work
 * that is already replica-local — but losing the race here costs nothing: the
 * losing replica's sessions are exactly as expired as the winner's, and its
 * own next tick clears them. A single shared lock key for a per-replica job is
 * harmless, not a bug, and keeping it means this task needs no bespoke
 * unlock-free path through the runner.
 *
 * A session past `sessionExpiryMs` is already refused by `authenticate()` —
 * this task frees the memory an expired-but-unread session would otherwise
 * hold until a login attempt happened to probe it, or forever if none ever
 * did.
 */

export interface AdminSessionStoreForPurge {
  /** Drops every session already past its own expiry. Returns how many. */
  deleteExpired(nowMs: number): Promise<number>
}

export interface AdminSessionPurgeDeps {
  readonly sessions: AdminSessionStoreForPurge
  /** `ADMIN_SESSION_PURGE_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
}

export function createAdminSessionPurgeTask(deps: AdminSessionPurgeDeps): ScheduledTask {
  return {
    name: "admin_session_purge",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger }) => {
      const removed = await deps.sessions.deleteExpired(now.getTime())

      logger.info("admin session purge", { outcome: "success", removed })
      return { outcome: "success", itemsProcessed: removed }
    },
  }
}
