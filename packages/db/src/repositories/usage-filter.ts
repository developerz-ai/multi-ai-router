import { type SQL, sql } from "drizzle-orm"
import { isAttributionDimension } from "./usage-attribution"
import type { UsageDimension, UsageFilter } from "./usage-read-types"

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
export function filterConditions(filter: UsageFilter, columns: FilterColumns): readonly SQL[] {
  // Typed required so a missing forward in src fails to compile. Tests are not type-checked and
  // several call the repositories without a filter, so an absent one at runtime means no filter.
  if ((filter as UsageFilter | undefined) === undefined) return []
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

/**
 * The array type a dimension's group ids bind as: `model` and the owner/tool buckets are text,
 * the remaining column dimensions are uuid. Both id-filter call sites — the raw breakdown's
 * `idsMatch` and the history `seriesQuery` — read this one mapping, so a future text dimension
 * has exactly one place to add it; spelled twice, the missed site binds text ids to `::uuid[]`
 * and every read of that dimension fails with 22P02 (#284). The parity is pinned per dimension
 * in `test/unit/repositories/usage-filter.test.ts`.
 */
export function dimensionIdType(dimension: UsageDimension): "text" | "uuid" {
  return dimension === "model" || isAttributionDimension(dimension) ? "text" : "uuid"
}

/**
 * Narrows a grouped read to the selected group ids: ONE typed array probe for the non-null ids,
 * plus an explicit `is null` term for the null group. Replaces a per-id `::text is not distinct
 * from` OR-chain, which at the 100-row breakdown cap made every retained row of a ~400k-row
 * window pay ~101 uuid→text casts and comparisons — the single dominant statement of the summary
 * read (#250). The ids arrive canonical (they came out of the same column as `::text`), so the
 * typed probe matches exactly the rows the chain matched. An empty list is `false`: nothing
 * matches, same contract the chain had.
 */
export function groupIdsMatch(
  column: SQL,
  type: "uuid" | "text",
  ids: readonly (string | null)[],
): SQL {
  const values = ids.filter((id): id is string => id !== null)
  const terms: SQL[] = []
  if (values.length > 0)
    terms.push(
      type === "uuid"
        ? sql`${column} = any(${sql.param(values)}::uuid[])`
        : sql`${column} = any(${sql.param(values)}::text[])`,
    )
  if (ids.some((id) => id === null)) terms.push(sql`${column} is null`)
  if (terms.length === 0) return sql`false`
  const [only] = terms
  if (terms.length === 1 && only !== undefined) return only
  return sql`(${sql.join(terms, sql` or `)})`
}
