import { asc, type SQL, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { type ApiKeyTombstoneRow, apiKeyTombstones } from "../schema/api-key-tombstones"
import { apiKeys } from "../schema/api-keys"
import { deleteOldestBatch } from "./bounded-delete"

/**
 * Tombstones for purged API keys: attribution without the secret (issue #224).
 *
 * Kept out of `api-key-repository.ts` on purpose. Nothing on the request path, no reveal and no
 * admin key list reads this table; the only reader is the usage label loader, through `listAll`.
 * Every `purged_at` comes from the caller's injected clock, never the database's `now()`.
 *
 * **This is the only production code that deletes an `api_keys` row** (bench and test cleanup aside). Both deletes (the janitor purge and the
 * operator delete) are one statement that also writes the tombstone, so a key's name cannot be lost
 * with its row.
 */
export interface ApiKeyTombstoneRepository {
  /**
   * Deletes keys revoked before `cutoff` — one bounded batch, oldest revocation first — and writes
   * their tombstones in the same statement. Returns how many keys went; exactly `limit` means there
   * is more. A revoked row whose `revoked_at` is NULL has no measurable age and is never swept.
   */
  purgeRevoked(cutoff: Date, purgedAt: Date, limit: number): Promise<number>
  /**
   * The operator delete: removes one key and writes its tombstone in the same statement.
   * `true` when a row was removed. A concurrent janitor purge cannot double-insert (the row lock lets
   * one DELETE return the row); `ON CONFLICT DO NOTHING` is belt and braces for a tombstone that
   * already exists for the id. Scope rows cascade.
   */
  deleteKey(id: string, purgedAt: Date): Promise<boolean>
  /** Every tombstone. Small by construction: one row per key rotated away in the retention window. */
  listAll(): Promise<ApiKeyTombstoneRow[]>
  /** Sweeps tombstones with `purged_at` before `cutoff`, bounded, oldest first. */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
}

/** The `api_keys` columns a tombstone copies, in the order of `TOMBSTONE_COLUMNS`. */
const COPIED = [
  apiKeys.id,
  apiKeys.name,
  apiKeys.prefix,
  apiKeys.owner,
  apiKeys.ownerKind,
  apiKeys.tool,
]
const TOMBSTONE_COLUMNS = sql.join(
  [
    apiKeyTombstones.id,
    apiKeyTombstones.name,
    apiKeyTombstones.prefix,
    apiKeyTombstones.owner,
    apiKeyTombstones.ownerKind,
    apiKeyTombstones.tool,
    apiKeyTombstones.purgedAt,
  ].map((column) => sql.identifier(column.name)),
  sql`, `,
)

/**
 * `DELETE ... RETURNING` feeding `INSERT ... ON CONFLICT DO NOTHING`, counted from the delete so a
 * skipped insert cannot understate how many keys went. Dates travel as ISO text with an explicit
 * cast: this is raw SQL, so no column encoder runs.
 */
async function deleteAndTombstone(
  db: DatabaseExecutor,
  where: SQL,
  purgedAt: Date,
): Promise<number> {
  const returned = sql.join(COPIED, sql`, `)
  const [row] = await db.execute<{ deleted: number }>(sql`
    WITH gone AS (
      DELETE FROM ${apiKeys} WHERE ${where} RETURNING ${returned}
    ), written AS (
      INSERT INTO ${apiKeyTombstones} (${TOMBSTONE_COLUMNS})
      SELECT ${sql.join(
        COPIED.map((column) => sql.identifier(column.name)),
        sql`, `,
      )}, ${purgedAt.toISOString()}::timestamptz
      FROM gone
      ON CONFLICT (${sql.identifier(apiKeyTombstones.id.name)}) DO NOTHING
    )
    SELECT count(*)::int AS deleted FROM gone`)
  return row?.deleted ?? 0
}

export function createApiKeyTombstoneRepository(db: DatabaseExecutor): ApiKeyTombstoneRepository {
  return {
    // Rides `api_keys_revoked_at_idx`. The `revoked` predicate is not redundant with a non-null
    // `revoked_at`: the flag is what `findUsableByPrefix` reads, so the sweep can only reach a key
    // verification already refuses.
    purgeRevoked: (cutoff, purgedAt, limit) =>
      deleteAndTombstone(
        db,
        sql`${apiKeys.id} IN (
          SELECT ${apiKeys.id} FROM ${apiKeys}
          WHERE ${apiKeys.revoked} = true AND ${apiKeys.revokedAt} < ${cutoff.toISOString()}::timestamptz
          ORDER BY ${apiKeys.revokedAt} ASC
          LIMIT ${limit}
        )`,
        purgedAt,
      ),

    deleteKey: async (id, purgedAt) =>
      (await deleteAndTombstone(db, sql`${apiKeys.id} = ${id}::uuid`, purgedAt)) > 0,

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
