import { type SQL, sql } from "drizzle-orm"
import type { usageRecords } from "../schema/usage-records"
import type { UsageDimension, UsageKeyAttribution } from "./usage-read-types"

/**
 * Grouping usage by who a key belongs to, folded in SQL.
 *
 * The fold happens before any row cap, so a hundred keys of one owner are one row, not a hundred
 * rows that a cap then cuts. The key-to-label map is injected by the service (labels are the
 * router's, not the database's) and arrives as four parallel arrays unnested into a relation: one
 * bind per array however many keys exist, where a VALUES list would cost three binds per key and
 * hit Postgres's 65535 parameter limit at about 21k keys plus tombstones.
 *
 * The three buckets below are group keys outside the slug grammar (`KEY_LABEL_SLUG` admits neither
 * `#` nor `/`), so no real owner or tool can collide with them. They are what the SQL groups on and
 * what the latency and series joins match on; the service nulls the id for the wire only after
 * every join is done, because three null ids would otherwise be indistinguishable.
 */
export const BUCKET_UNASSIGNED = "#unassigned"
export const BUCKET_DELETED = "#deleted"
export const BUCKET_NONE = "#none"

export function isAttributionDimension(dimension: UsageDimension): dimension is "owner" | "tool" {
  return dimension === "owner" || dimension === "tool"
}

/** `unnest(...) as m(id, owner, kind, tool)`: the injected key labels as a relation. */
export function attributionRelation(attribution: UsageKeyAttribution | undefined): SQL {
  // Required for owner and tool: without the mapping every key would read as deleted, a silent
  // misgroup. An empty mapping (no keys) is legitimate; an absent one is a caller bug.
  if (attribution === undefined)
    throw new Error("usage owner/tool breakdown requires a key attribution")
  const a = attribution
  return sql`unnest(${sql.param([...a.ids])}::uuid[], ${sql.param([...a.owners])}::text[], ${sql.param([...a.ownerKinds])}::text[], ${sql.param([...a.tools])}::text[]) as m(id, owner, kind, tool)`
}

/**
 * The bucket a key lands in for one dimension. `m` is `attributionRelation` left-joined on the key.
 * Order matters: no key at all, then a key the router has no label for (gone without a tombstone),
 * then a key that exists but names nothing, then the label itself. An owner with no kind groups
 * under `unknown/` so a person and a service sharing a slug stay two rows.
 */
export function bucketSql(dimension: "owner" | "tool", keyColumn: SQL): SQL {
  const own = dimension === "owner" ? sql.raw("m.owner") : sql.raw("m.tool")
  const label =
    dimension === "owner" ? sql`coalesce(m.kind, 'unknown') || '/' || m.owner` : sql.raw("m.tool")
  return sql`case when ${keyColumn} is null then ${sql.raw(`'${BUCKET_NONE}'`)} when m.id is null then ${sql.raw(`'${BUCKET_DELETED}'`)} when ${own} is null then ${sql.raw(`'${BUCKET_UNASSIGNED}'`)} else ${label} end`
}

/**
 * Raw-table source for a read grouped by owner or tool: the window and filter are applied inside,
 * the bucket is added as `grp`, and the whole thing is aliased back to `usage_records` so the
 * repository's column references and aggregates keep working unchanged. The cast is the one lie:
 * the select builder only needs a from-source, and every field it selects is an explicit fragment.
 */
export function attributedRaw(
  inWindow: SQL | undefined,
  dimension: "owner" | "tool",
  attribution: UsageKeyAttribution | undefined,
): { from: typeof usageRecords; group: SQL } {
  const inner = sql`(select usage_records.*, ${bucketSql(dimension, sql`usage_records.api_key_id`)} as grp from usage_records left join ${attributionRelation(attribution)} on m.id = usage_records.api_key_id where ${inWindow ?? sql`true`}) as usage_records`
  return { from: inner as unknown as typeof usageRecords, group: sql`usage_records.grp` }
}
