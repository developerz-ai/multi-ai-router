import { type SQL, sql } from "drizzle-orm"
import type { UsageFilter } from "./usage-read-types"

/** The four column expressions a filter constrains, spelled per source (a column, a payload cast). */
export interface FilterColumns {
  readonly apiKeyId: SQL
  readonly accountId: SQL
  readonly poolId: SQL
  readonly model: SQL
}

/**
 * One `column = any($n::type[])` condition per filtered dimension, to be AND-ed by the caller.
 *
 * Each id list is bound as ONE array parameter. drizzle expands a bare JS array in an `sql`
 * template into a parenthesised list (`($1, $2)`), which is a row, not an array, so the list is
 * wrapped in `sql.param`. That keeps the statement text constant whatever the list length (no
 * 1000-id ceiling, one plan shape) and an empty list is `any('{}')`, which is false: an empty
 * set filters everything out in SQL rather than being special-cased in TypeScript.
 *
 * A NULL column never satisfies `= any(...)`, so a pool filter cannot select the pool-less rows.
 */
export function filterConditions(
  filter: UsageFilter | undefined,
  columns: FilterColumns,
): readonly SQL[] {
  if (filter === undefined) return []
  const conditions: SQL[] = []
  const add = (column: SQL, values: readonly string[] | undefined, type: "uuid" | "text") => {
    if (values === undefined) return
    const list = sql.param([...values])
    conditions.push(
      type === "uuid"
        ? sql`${column} = any(${list}::uuid[])`
        : sql`${column} = any(${list}::text[])`,
    )
  }
  add(columns.apiKeyId, filter.apiKeyIds, "uuid")
  add(columns.accountId, filter.accountIds, "uuid")
  add(columns.poolId, filter.poolIds, "uuid")
  add(columns.model, filter.models, "text")
  return conditions
}

/** ` and a and b`, or nothing, so a fragment can be appended to an existing where clause. */
export function andAll(conditions: readonly SQL[]): SQL {
  return conditions.length === 0 ? sql`` : sql` and ${sql.join([...conditions], sql` and `)}`
}
