import { and, eq, gt, isNull, or } from "drizzle-orm"
import type { Database } from "../client"
import { type ApiKeyRow, apiKeys } from "../schema/api-keys"

/**
 * Repositories own SQL. Services call these methods and never write a query
 * inline — this file is the only place that knows `api_keys` is a table.
 *
 * The verification lookup is a cache *miss* path: the data plane answers from a
 * warm in-memory cache and only lands here on a miss, as a single indexed query.
 */
export interface ApiKeyRepository {
  /**
   * Rows whose display prefix matches and that are still usable at `now`.
   * A prefix is not unique by construction, so the caller decrypts each
   * candidate and compares in constant time — the index narrows, it never decides.
   */
  findUsableByPrefix(prefix: string, now: Date): Promise<ApiKeyRow[]>
  findById(id: string): Promise<ApiKeyRow | undefined>
  markRevoked(id: string, now: Date): Promise<void>
  touchLastUsed(id: string, now: Date): Promise<void>
}

export function createApiKeyRepository(db: Database): ApiKeyRepository {
  return {
    findUsableByPrefix: (prefix, now) =>
      db
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.prefix, prefix),
            eq(apiKeys.revoked, false),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
          ),
        ),

    findById: async (id) => {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1)
      return rows[0]
    },

    markRevoked: async (id, now) => {
      await db
        .update(apiKeys)
        .set({ revoked: true, revokedAt: now, updatedAt: now })
        .where(eq(apiKeys.id, id))
    },

    touchLastUsed: async (id, now) => {
      await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id))
    },
  }
}
