import { and, asc, eq, inArray, lt } from "drizzle-orm"
import type { Database } from "../client"
import {
  type SessionFingerprintSource,
  type SessionLineageState,
  type SessionRow,
  sessions,
} from "../schema/sessions"

/**
 * Conversation identity. Repositories own SQL; this file is the only place that
 * knows `sessions` is a table.
 *
 * On the Claude subscription path this table is **persisted truth, not a
 * cache**: an SDK session id resumes only on the account that created it, so the
 * binding records where a conversation physically lives upstream and no policy
 * may overrule it. Anything in front of these methods is a read-through cache of
 * that fact, never the authority.
 *
 * Every lookup is scoped by `apiKeyId` — a session key is caller-supplied, so
 * two keys both sending `session-1` must never see each other's binding. The
 * `sessions_api_key_key_key` unique index is what makes that scope enforceable
 * rather than merely intended.
 */
export interface SessionRepository {
  /** The lookup. `undefined` on a first request, which is the normal case. */
  findByKey(apiKeyId: string, key: string): Promise<SessionRow | undefined>
  /**
   * Creates the row or refreshes it in place, keyed on
   * (`apiKeyId`, `key`). Absent fields are left as they are on an existing row —
   * touching `lastUsedAt` alone must not erase a live binding — while an
   * explicit `null` clears one.
   */
  upsert(input: UpsertSessionInput): Promise<SessionRow>
  /**
   * Invalidates every binding onto an account, and returns how many. The
   * conversation survives; only its placement is forgotten.
   *
   * **Never moved to another account.** An SDK session id is meaningless off the
   * account that minted it, so re-pointing the row would hand the next request a
   * resume token the new upstream has never seen. `lastUsedAt` is deliberately
   * untouched, so a cleared row still ages out on its own idle clock.
   */
  clearAccount(accountId: string): Promise<number>
  /**
   * Deletes idle sessions in one bounded batch, oldest first, and returns how
   * many went. Fewer than `limit` means the sweep is caught up; exactly `limit`
   * means there is more and the run should report `partial`.
   */
  deleteIdleBefore(cutoff: Date, limit: number): Promise<number>
}

export interface UpsertSessionInput {
  readonly apiKeyId: string
  /** Client-supplied header verbatim, else the derived fingerprint. */
  readonly key: string
  /** The binding. SDK path only; `null` clears it. */
  readonly accountId?: string | null
  /** Meaningful only alongside `accountId`; cleared with it. */
  readonly sdkSessionId?: string | null
  readonly lineageState?: SessionLineageState | null
  readonly fingerprintSource?: SessionFingerprintSource | null
  /** Drives the idle expiry sweep, so every touch supplies it. */
  readonly lastUsedAt: Date
}

export function createSessionRepository(db: Database): SessionRepository {
  return {
    findByKey: async (apiKeyId, key) => {
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.apiKeyId, apiKeyId), eq(sessions.key, key)))
        .limit(1)
      return rows[0]
    },

    // Spread-per-field rather than a loop: an absent key must stay absent on the
    // conflict update (leaving the stored value), while `null` must survive as
    // the explicit clear. The same object is the insert's values and the
    // update's set, so the two branches cannot drift.
    upsert: async (input) => {
      const mutable = {
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.sdkSessionId === undefined ? {} : { sdkSessionId: input.sdkSessionId }),
        ...(input.lineageState === undefined ? {} : { lineageState: input.lineageState }),
        ...(input.fingerprintSource === undefined
          ? {}
          : { fingerprintSource: input.fingerprintSource }),
        lastUsedAt: input.lastUsedAt,
      }
      const rows = await db
        .insert(sessions)
        .values({ apiKeyId: input.apiKeyId, key: input.key, ...mutable })
        .onConflictDoUpdate({ target: [sessions.apiKeyId, sessions.key], set: mutable })
        .returning()
      const row = rows[0]
      if (row === undefined) {
        throw new Error("sessionRepository.upsert: statement returned no row")
      }
      return row
    },

    clearAccount: async (accountId) => {
      const rows = await db
        .update(sessions)
        .set({ accountId: null, sdkSessionId: null, lineageState: null })
        .where(eq(sessions.accountId, accountId))
        .returning({ id: sessions.id })
      return rows.length
    },

    // Deleted by id from an ordered, limited subselect rather than by
    // `where last_used_at < cutoff limit n` — which Postgres does not accept on
    // a DELETE at all, and which would otherwise be an unbounded delete holding
    // locks across the whole table. The subselect rides
    // `sessions_last_used_at_idx`.
    deleteIdleBefore: async (cutoff, limit) => {
      const oldest = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(lt(sessions.lastUsedAt, cutoff))
        .orderBy(asc(sessions.lastUsedAt))
        .limit(limit)
      const rows = await db
        .delete(sessions)
        .where(inArray(sessions.id, oldest))
        .returning({ id: sessions.id })
      return rows.length
    },
  }
}
