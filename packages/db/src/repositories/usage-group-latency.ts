import { sql } from "drizzle-orm"
import type { Database } from "../client"
import { attributionRelation, bucketSql } from "./usage-attribution"
import { andAll, dimensionIdType, filterConditions, groupIdsMatch } from "./usage-filter"
import type {
  UsageDimension,
  UsageFilter,
  UsageGroupLatency,
  UsageKeyAttribution,
  UsageWindow,
} from "./usage-read-types"

/** The group ids each dimension's breakdown selected: the only groups whose rows are returned. */
export type UsageGroupIds = Readonly<Record<UsageDimension, readonly (string | null)[]>>

/** Every dimension's per-group latency, from one statement. */
export type UsageGroupLatencies = Readonly<Record<UsageDimension, readonly UsageGroupLatency[]>>

/** Each dimension and the column of the scoped scan it groups on. */
const COLUMNS: readonly (readonly [UsageDimension, string])[] = [
  ["apiKeyId", "api_key_id"],
  ["accountId", "account_id"],
  ["poolId", "pool_id"],
  ["model", "model"],
  ["owner", "owner_grp"],
  ["tool", "tool_grp"],
]

/**
 * Per-group p50/p95 latency and p95 router overhead for all six dimensions, over one scan of the
 * window's raw rows.
 *
 * The summary used to ask this as six `breakdown` statements, one per dimension, each re-reading
 * the same `created_at` range and each also computing the totals nobody read from it (prod: 340 to
 * 450 ms apiece, serial on the snapshot's one connection, inside a 9 s `GET /api/admin/usage`).
 * Here the window is scanned once into a materialized relation, and one arm per dimension
 * aggregates only the ids that dimension's breakdown selected (at most 1000, the bound `breakdown`
 * has): `model` is whatever a key holder typed, so "every group in the window" has no ceiling.
 *
 * Same window, filter and owner/tool buckets as `breakdown`, so a group's numbers are identical.
 */
export async function readGroupLatency(
  db: Database,
  window: UsageWindow,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
  ids: UsageGroupIds,
): Promise<UsageGroupLatencies> {
  for (const [dimension] of COLUMNS)
    if (ids[dimension].length > 1000) throw new Error("usage breakdown outside bounds")
  const column = (name: string) => sql`usage_records.${sql.identifier(name)}`
  const where = andAll(
    filterConditions(filter, {
      apiKeyId: column("api_key_id"),
      accountId: column("account_id"),
      poolId: column("pool_id"),
      model: column("model"),
    }),
  )
  // One arm per dimension over the one materialized scan, each narrowed to its selected ids
  // BEFORE it aggregates: grouped first and filtered after, every model a key holder ever typed
  // had its three percentiles sorted and computed only to be thrown away.
  const arms = COLUMNS.map(
    ([dimension, name], index) => sql`
      select ${index}::int as dim, ${sql.raw(name)}::text as id,
        (percentile_disc(0.5) within group (order by latency_ms))::int as "latencyP50Ms",
        (percentile_disc(0.95) within group (order by latency_ms))::int as "latencyP95Ms",
        (percentile_disc(0.95) within group (order by router_overhead_ms))::int as "routerOverheadP95Ms"
      from scoped
      where ${groupIdsMatch(sql.raw(name), dimensionIdType(dimension), ids[dimension])}
      group by ${sql.raw(name)}`,
  )
  const rows = await db.execute<{
    dim: number
    id: string | null
    latencyP50Ms: number | null
    latencyP95Ms: number | null
    routerOverheadP95Ms: number | null
  }>(sql`
    with scoped as materialized (
      select usage_records.api_key_id, usage_records.account_id, usage_records.pool_id,
        usage_records.model, usage_records.latency_ms, usage_records.router_overhead_ms,
        ${bucketSql("owner", column("api_key_id"))} as owner_grp,
        ${bucketSql("tool", column("api_key_id"))} as tool_grp
      from usage_records left join ${attributionRelation(attribution)} on m.id = usage_records.api_key_id
      where usage_records.created_at >= ${window.from.toISOString()}::timestamptz
        and usage_records.created_at < ${window.to.toISOString()}::timestamptz${where}
    )
    ${sql.join(arms, sql` union all `)}`)
  const byDimension = COLUMNS.map((): UsageGroupLatency[] => [])
  for (const { dim, ...row } of rows) byDimension[dim]?.push(row)
  return Object.fromEntries(
    COLUMNS.map(([dimension], index) => [dimension, byDimension[index] ?? []]),
  ) as Record<UsageDimension, UsageGroupLatency[]>
}
