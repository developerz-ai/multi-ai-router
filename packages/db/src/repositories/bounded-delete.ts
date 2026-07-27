import { and, asc, inArray, lt, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import type { Database } from "../client"

/**
 * The one shape every retention sweep deletes with. Stated once here rather than
 * five times across the repositories that call it.
 *
 * Postgres accepts no `LIMIT` on a `DELETE`, so the batch is chosen by an
 * ordered, limited subselect of ids and deleted by id. The obvious alternative —
 * a bare `delete … where created_at < cutoff` — is an unbounded statement
 * holding row locks across the whole table, which is exactly what a janitor must
 * never do to a live write path.
 *
 * Oldest first, so a backlog drains in order and each run resumes where the last
 * one stopped. The returned count is the caller's `partial` signal: fewer than
 * `limit` means the sweep is caught up, exactly `limit` means there is more.
 *
 * Nothing here decides *how old is old*. Every window is config (CLAUDE.md
 * non-negotiable 11); this function is handed a cutoff.
 */
export interface BoundedDeleteOptions {
  readonly db: Database
  readonly table: PgTable
  /** The primary key the batch is deleted by. */
  readonly id: PgColumn
  /**
   * The age column: both the `< cutoff` predicate and the order the batch drains
   * in. An indexed column, or the subselect is a sort of the whole table.
   *
   * A NULL here is never swept — SQL comparison excludes it — which is the right
   * reading: a row with no timestamp has no measurable age.
   */
  readonly agedBy: PgColumn
  /**
   * Rows strictly older than this go.
   *
   * A string where the age column is a `date` rather than a `timestamptz` — drizzle binds the
   * value through the column's own encoder, and a `date` column's encoder speaks `YYYY-MM-DD`.
   */
  readonly cutoff: Date | string
  /** Ceiling on one batch. */
  readonly limit: number
  /** Extra narrowing ANDed onto the age predicate, e.g. `revoked = true`. */
  readonly narrowedBy?: SQL
}

/** Deletes one bounded batch of aged rows, oldest first, and returns how many went. */
export async function deleteOldestBatch(options: BoundedDeleteOptions): Promise<number> {
  const { db, table, id, agedBy, cutoff, limit, narrowedBy } = options
  const aged = lt(agedBy, cutoff)

  const oldest = db
    .select({ id })
    .from(table)
    .where(narrowedBy === undefined ? aged : and(aged, narrowedBy))
    .orderBy(asc(agedBy))
    .limit(limit)

  const deleted = await db.delete(table).where(inArray(id, oldest)).returning({ id })
  return deleted.length
}
