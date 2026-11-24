import { type SQL, sql } from "drizzle-orm"
import { attributionRelation, bucketSql } from "./usage-attribution"
import { dimensionIdType, groupIdsMatch } from "./usage-filter"
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

/** Each dimension and the column of the labelled fold it groups on. */
const COLUMNS: readonly (readonly [UsageDimension, string])[] = [
  ["apiKeyId", "api_key_id"],
  ["accountId", "account_id"],
  ["poolId", "pool_id"],
  ["model", "model"],
  ["owner", "owner_grp"],
  ["tool", "tool_grp"],
]
const MEASURES = ["requests", "attempts", "errors", "tokens_in", "tokens_out"]

/**
 * The sparkline series of all six breakdowns, from one statement.
 *
 * The summary asked this as six `seriesByDimension` statements, each rebuilding the four-source
 * `facts` union and re-parsing the edge days' receipts (prod: about 300 ms apiece, serial on the
 * snapshot's one connection). Here the facts are read once, folded to the (bucket, key, account,
 * pool, model) grain — sums of sums are exact, the argument the owner/tool fold already rests on —
 * labelled once with both buckets and materialized; one arm per dimension then sums only the ids
 * that dimension's breakdown selected, as `seriesByDimension` does.
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
  const sums = sql.join(
    MEASURES.map((name) => sql`sum(${sql.identifier(name)}) as ${sql.identifier(name)}`),
    sql`, `,
  )
  // One arm per dimension over the one labelled fold, each narrowed to its selected ids BEFORE it
  // aggregates, so the chart buckets of groups nobody selected are never summed.
  const arms = COLUMNS.map(
    ([dimension, name], index) => sql`
      select ${index}::int as dim, at, ${sql.raw(name)}::text as id,
        sum(requests)::float8 as requests, sum(attempts)::float8 as attempts, sum(errors)::float8 as errors,
        sum(tokens_in)::float8 as "tokensIn", sum(tokens_out)::float8 as "tokensOut"
      from labelled
      where ${groupIdsMatch(sql.raw(name), dimensionIdType(dimension), ids[dimension])}
      group by at, ${sql.raw(name)}`,
  )
  const rows = await read<UsageGroupSeriesPoint & { readonly dim: number }>(sql`
    with facts as (${historySource(window, bucket === "hour", filter)}),
    folded as (
      select date_bin(${interval}::interval, event_at, '1970-01-01 00:00:00+00'::timestamptz) as at,
        api_key_id, account_id, pool_id, model, ${sums}
      from facts group by 1, 2, 3, 4, 5
    ),
    labelled as materialized (
      select f.*, ${bucketSql("owner", sql`f.api_key_id`)} as owner_grp, ${bucketSql("tool", sql`f.api_key_id`)} as tool_grp
      from folded f left join ${attributionRelation(attribution)} on m.id = f.api_key_id
    )
    select dim, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
      id, requests, attempts, errors, "tokensIn", "tokensOut"
    from (${sql.join(arms, sql` union all `)}) grouped
    order by 2`)
  const byDimension = COLUMNS.map((): UsageGroupSeriesPoint[] => [])
  for (const { dim, ...point } of rows) byDimension[dim]?.push(point)
  return Object.fromEntries(
    COLUMNS.map(([dimension], index) => [dimension, byDimension[index] ?? []]),
  ) as Record<UsageDimension, UsageGroupSeriesPoint[]>
}
