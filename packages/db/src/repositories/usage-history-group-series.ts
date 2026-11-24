import { type SQL, sql } from "drizzle-orm"
import { attributionRelation, bucketSql } from "./usage-attribution"
import { groupIdsMatch } from "./usage-filter"
import type { UsageGroupIds } from "./usage-group-latency"
import { historySource } from "./usage-history-source"
import type {
  UsageDimension,
  UsageFilter,
  UsageGroupSeriesPoint,
  UsageKeyAttribution,
  UsageWindow,
} from "./usage-read-types"

/** Every dimension's per-group series, from one statement. */
export type UsageGroupSeries = Readonly<Record<UsageDimension, readonly UsageGroupSeriesPoint[]>>

/** The grouping columns, in `grouping(...)` argument order (leftmost is the most significant bit). */
const COLUMNS: readonly (readonly [UsageDimension, string])[] = [
  ["apiKeyId", "api_key_id"],
  ["accountId", "account_id"],
  ["poolId", "pool_id"],
  ["model", "model"],
  ["owner", "owner_grp"],
  ["tool", "tool_grp"],
]
const ALL = (1 << COLUMNS.length) - 1
const maskOf = (index: number) => ALL - (1 << (COLUMNS.length - 1 - index))
const MEASURES = ["requests", "attempts", "errors", "tokens_in", "tokens_out"]

/**
 * The sparkline series of all six breakdowns, from one statement.
 *
 * The summary asked this as six `seriesByDimension` statements, each rebuilding the four-source
 * `facts` union and re-parsing the edge days' receipts (prod: about 300 ms apiece, serial on the
 * snapshot's one connection). Here the facts are read once, folded to the (bucket, key, account,
 * pool, model) grain — sums of sums are exact, the argument the owner/tool fold already rests on —
 * labelled once with both buckets, then aggregated over `GROUPING SETS` of the bucket with each
 * dimension alone. Only the ids each breakdown selected come back, as `seriesByDimension` does.
 *
 * `attribution.ids` must be unique: the label join is a left join, and a repeated id would multiply
 * that key's facts in every set.
 */
export async function readGroupSeries(
  read: <T>(query: SQL) => Promise<T[]>,
  window: UsageWindow,
  bucket: "hour" | "day",
  requestedWidth: number | undefined,
  ids: UsageGroupIds,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
): Promise<UsageGroupSeries> {
  const width = requestedWidth ?? 1
  if (!Number.isSafeInteger(width) || width < 1 || width > 1000000)
    throw new Error("usage series width outside bounds")
  for (const [dimension] of COLUMNS)
    if (ids[dimension].length > 1000) throw new Error("usage breakdown outside bounds")
  const interval = `${width} ${bucket === "hour" ? "hours" : "days"}`
  const columns = COLUMNS.map(([, name]) => sql.raw(name))
  const grouping = sql`grouping(${sql.join(columns, sql`, `)})`
  const id = sql`case ${grouping} ${sql.join(
    COLUMNS.map(([, name], index) => sql`when ${maskOf(index)} then ${sql.raw(name)}::text`),
    sql` `,
  )} end`
  const sums = sql.join(
    MEASURES.map((name) => sql`sum(${sql.identifier(name)}) as ${sql.identifier(name)}`),
    sql`, `,
  )
  const rows = await read<UsageGroupSeriesPoint & { readonly setMask: number }>(sql`
    with facts as (${historySource(window, bucket === "hour", filter)}),
    folded as (
      select date_bin(${interval}::interval, event_at, '1970-01-01 00:00:00+00'::timestamptz) as at,
        api_key_id, account_id, pool_id, model, ${sums}
      from facts group by 1, 2, 3, 4, 5
    ),
    labelled as (
      select f.*, ${bucketSql("owner", sql`f.api_key_id`)} as owner_grp, ${bucketSql("tool", sql`f.api_key_id`)} as tool_grp
      from folded f left join ${attributionRelation(attribution)} on m.id = f.api_key_id
    ),
    grouped as (
      select ${grouping}::int as set_mask, ${id} as id, at,
        sum(requests)::float8 as requests, sum(attempts)::float8 as attempts, sum(errors)::float8 as errors,
        sum(tokens_in)::float8 as "tokensIn", sum(tokens_out)::float8 as "tokensOut"
      from labelled
      group by grouping sets (${sql.join(
        columns.map((name) => sql`(at, ${name})`),
        sql`, `,
      )})
    )
    select set_mask as "setMask", to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
      id, requests, attempts, errors, "tokensIn", "tokensOut"
    from grouped where ${sql.join(
      COLUMNS.map(
        ([dimension], index) =>
          sql`(set_mask = ${maskOf(index)} and ${groupIdsMatch(sql`id`, "text", ids[dimension])})`,
      ),
      sql` or `,
    )}
    order by 2`)
  const byMask = new Map<number, UsageGroupSeriesPoint[]>()
  for (const { setMask, ...point } of rows) {
    const group = byMask.get(setMask) ?? []
    group.push(point)
    byMask.set(setMask, group)
  }
  return Object.fromEntries(
    COLUMNS.map(([dimension], index) => [dimension, byMask.get(maskOf(index)) ?? []]),
  ) as Record<UsageDimension, UsageGroupSeriesPoint[]>
}
