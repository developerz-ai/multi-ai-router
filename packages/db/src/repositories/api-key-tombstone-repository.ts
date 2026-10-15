import type { KeyOwnerKind } from "@multi-ai-router/core"
import { asc, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { type ApiKeyTombstoneRow, apiKeyTombstones } from "../schema/api-key-tombstones"
import { deleteOldestBatch } from "./bounded-delete"

/**
 * Tombstones for purged API keys: attribution without the secret (issue #224).
 *
 * Kept out of `api-key-repository.ts` on purpose. Nothing on the request path, no reveal and no
 * admin key list reads this table; the only reader is the usage label loader, through `listAll`.
 * Every `purged_at` comes from the caller's injected clock, never the database's `now()`.
 */
export interface ApiKeyTombstoneRepository {
  /**
   * Deletes keys revoked before `cutoff` — one bounded batch, oldest revocation first — and writes
   * their tombstones in the same statement, so a crash cannot lose a key's name with its row.
   * Returns how many keys went; exactly `limit` means there is more. A revoked row whose
   * `revoked_at` is NULL has no measurable age and is never swept.
   */
  purgeRevoked(cutoff: Date, purgedAt: Date, limit: number): Promise<number>
  /**
   * Records one key's tombstone, for the operator delete (which removes the row itself in the same
   * transaction). `ON CONFLICT DO NOTHING`: a delete racing a janitor purge must not collide.
   */
  record(key: TombstoneSource, purgedAt: Date): Promise<void>
  /** Every tombstone. Small by construction: one row per key rotated away in the retention window. */
  listAll(): Promise<ApiKeyTombstoneRow[]>
  /** Sweeps tombstones with `purged_at` before `cutoff`, bounded, oldest first. */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
}

export interface TombstoneSource {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly owner: string | null
  readonly ownerKind: KeyOwnerKind | null
  readonly tool: string | null
}

export function createApiKeyTombstoneRepository(db: DatabaseExecutor): ApiKeyTombstoneRepository {
  return {
    // Rides `api_keys_revoked_at_idx`. The `revoked` predicate is not redundant with a non-null
    // `revoked_at`: the flag is what `findUsableByPrefix` reads, so the sweep can only reach a key
    // verification already refuses.
    purgeRevoked: async (cutoff, purgedAt, limit) => {
      // Dates go as ISO text with an explicit cast: this is raw SQL, so no column encoder runs.
      const rows = await db.execute(sql`
        WITH gone AS (
          DELETE FROM api_keys
          WHERE id IN (
            SELECT id FROM api_keys
            WHERE revoked = true AND revoked_at < ${cutoff.toISOString()}::timestamptz
            ORDER BY revoked_at ASC
            LIMIT ${limit}
          )
          RETURNING id, name, prefix, owner, owner_kind, tool
        ), written AS (
          INSERT INTO api_key_tombstones (id, name, prefix, owner, owner_kind, tool, purged_at)
          SELECT id, name, prefix, owner, owner_kind, tool, ${purgedAt.toISOString()}::timestamptz
          FROM gone
          ON CONFLICT (id) DO NOTHING
        )
        SELECT count(*)::int AS deleted FROM gone`)
      const first = (rows as unknown as readonly { deleted: number }[])[0]
      return first?.deleted ?? 0
    },

    record: async (key, purgedAt) => {
      await db
        .insert(apiKeyTombstones)
        .values({
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          owner: key.owner,
          ownerKind: key.ownerKind,
          tool: key.tool,
          purgedAt,
        })
        .onConflictDoNothing({ target: apiKeyTombstones.id })
    },

    listAll: () => db.select().from(apiKeyTombstones).orderBy(asc(apiKeyTombstones.purgedAt)),

    deleteOlderThan: (cutoff, limit) =>
      deleteOldestBatch({
        db,
        table: apiKeyTombstones,
        id: apiKeyTombstones.id,
        agedBy: apiKeyTombstones.purgedAt,
        cutoff,
        limit,
      }),
  }
}
