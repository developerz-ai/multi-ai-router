import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm"
import type { Database } from "../client"
import { type AdminSessionRow, adminSessions } from "../schema/admin-sessions"

/**
 * Durable admin console sessions. Repositories own SQL; this file is the only
 * place that knows `admin_sessions` is a table.
 *
 * **Hash in, hash out.** Every method is addressed by `idHash`, the SHA-256 of
 * the opaque cookie id, and the raw id never crosses this boundary in either
 * direction — the store hashes before calling in (`hashSessionId` in
 * `apps/api/src/services/admin-auth/postgresSessionStore.ts`) and a row read
 * back cannot name the cookie that owns it. Hashing is not a `packages/db`
 * concern (docs/reusable-code.md), which is why it does not happen here.
 */
export interface AdminSessionRepository {
  find(idHash: string): Promise<AdminSessionRow | undefined>
  /** Inserts a newly minted session; never modifies an existing identity. */
  create(row: AdminSessionRow): Promise<void>
  /** Slides only a live existing session. A revoked/expired row cannot be recreated. */
  touch(row: AdminSessionRow): Promise<boolean>
  /** Deletes one session. Returns whether a row existed to delete. */
  delete(idHash: string): Promise<boolean>
  /**
   * Deletes sessions whose earlier bound — idle or absolute — is at or before
   * `cutoff`, in one bounded batch, soonest-expired first. Returns how many
   * went; exactly `limit` means there is more and the run should report
   * `partial`, the same signal every other sweep gives `runSweeps`.
   */
  deleteExpiredBefore(cutoff: Date, limit: number): Promise<number>
}

export function createAdminSessionRepository(db: Database): AdminSessionRepository {
  return {
    find: async (idHash) => {
      const rows = await db
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.idHash, idHash))
        .limit(1)
      return rows[0]
    },

    create: async (row) => {
      await db.insert(adminSessions).values(row).onConflictDoNothing()
    },

    touch: async (row) => {
      const updated = await db
        .update(adminSessions)
        .set({
          lastSeenAt: sql`greatest(${adminSessions.lastSeenAt}, ${row.lastSeenAt.toISOString()}::timestamptz)`,
          idleExpiryAt: sql`greatest(${adminSessions.idleExpiryAt}, ${row.idleExpiryAt.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(adminSessions.idHash, row.idHash),
            gt(adminSessions.idleExpiryAt, row.lastSeenAt),
            gt(adminSessions.absoluteExpiryAt, row.lastSeenAt),
          ),
        )
        .returning({ idHash: adminSessions.idHash })
      return updated.length > 0
    },

    delete: async (idHash) => {
      const rows = await db
        .delete(adminSessions)
        .where(eq(adminSessions.idHash, idHash))
        .returning({ idHash: adminSessions.idHash })
      return rows.length > 0
    },

    // The same shape as `deleteOldestBatch` — an ordered, limited subselect of
    // keys, deleted by key — written out rather than reused because the age of
    // a session is `least(idle_expiry_at, absolute_expiry_at)`, an expression,
    // and that helper drains by a single indexed column. Spelled as an `OR` of
    // two `<=` predicates rather than `least(...) <= cutoff` so Postgres can
    // bitmap-or the two expiry indexes; `least` on the ORDER BY only orders
    // the (small) matched set. `<=`, not `<`: `sessionExpiryMs(s) <= now` is
    // what `authenticate()` refuses, and the purge must agree with it.
    deleteExpiredBefore: async (cutoff, limit) => {
      const expired = or(
        lte(adminSessions.idleExpiryAt, cutoff),
        lte(adminSessions.absoluteExpiryAt, cutoff),
      )
      const soonestExpired = db
        .select({ idHash: adminSessions.idHash })
        .from(adminSessions)
        .where(expired)
        .orderBy(asc(sql`least(${adminSessions.idleExpiryAt}, ${adminSessions.absoluteExpiryAt})`))
        .limit(limit)
      const deleted = await db
        .delete(adminSessions)
        .where(inArray(adminSessions.idHash, soonestExpired))
        .returning({ idHash: adminSessions.idHash })
      return deleted.length
    },
  }
}
