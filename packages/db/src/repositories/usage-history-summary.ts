import { type SQL, sql } from "drizzle-orm"
import { attributionRelation, bucketSql } from "./usage-attribution"
import { historyMeasures, historySource, historySums } from "./usage-history-source"
import {
  nestUnpriced,
  type UnpricedRow,
  type UsageDimension,
  type UsageFilter,
  type UsageGroupRow,
  type UsageKeyAttribution,
  type UsageTotals,
  type UsageWindow,
} from "./usage-read-types"

/** `totals` plus every dimension's `breakdown`, from one statement. */
export interface UsageSummaryAggregates {
  readonly totals: UsageTotals
  readonly breakdowns: Readonly<Record<UsageDimension, readonly UsageGroupRow[]>>
}

/**
 * The grouping columns, in `grouping(...)` argument order. `grouping()` sets a bit for every
 * argument a row is aggregated *across*, leftmost most significant, so the set grouped by exactly
 * one column reads all-ones minus that column's bit, and the grand total reads all-ones.
 */
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

type Row = Omit<UsageGroupRow, "unpriced"> & UnpricedRow & { readonly setMask: number }

/**
 * One statement for what a summary load used to ask in seven (`totals` + six `breakdown`s), each
 * of which rebuilt the four-source `facts` union and, for owner/tool, re-joined the key labels.
 *
 * Facts are folded once to the (key, account, pool, model) grain — sums of sums are exact, the
 * same argument the owner/tool fold already rests on — labelled once with both the owner and the
 * tool bucket, then aggregated over `GROUPING SETS` of the empty set and each dimension alone. Each
 * set is ranked exactly as `breakdown` orders (`tokens_in + tokens_out` desc, id text nulls last)
 * and cut at `limit`. Results are identical to the separate reads; the differential test pins it.
 *
 * `attribution.ids` must be unique (it is built from a map): the label join is a left join, and a
 * repeated id would multiply that key's facts in every set, not only in owner/tool.
 */
export async function readSummaryAggregates(
  read: <T>(query: SQL) => Promise<T[]>,
  window: UsageWindow,
  limit: number,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
): Promise<UsageSummaryAggregates> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001)
    throw new Error("usage breakdown outside bounds")
  const columns = COLUMNS.map(([, column]) => sql.raw(column))
  const grouping = sql`grouping(${sql.join(columns, sql`, `)})`
  const sets = sql.join(
    columns.map((column) => sql`(${column})`),
    sql`, `,
  )
  const id = sql`case ${grouping} ${sql.join(
    COLUMNS.map(([, column], index) => sql`when ${maskOf(index)} then ${sql.raw(column)}::text`),
    sql` `,
  )} end`
  const sums = sql.join(
    historyMeasures.map((name) => sql`sum(${sql.identifier(name)}) as ${sql.identifier(name)}`),
    sql`, `,
  )
  const rows = await read<Row>(sql`
    with facts as (${historySource(window, false, filter)}),
    folded as (select api_key_id, account_id, pool_id, model, ${sums} from facts group by 1, 2, 3, 4),
    labelled as (
      select f.*, ${bucketSql("owner", sql`f.api_key_id`)} as owner_grp, ${bucketSql("tool", sql`f.api_key_id`)} as tool_grp
      from folded f left join ${attributionRelation(attribution)} on m.id = f.api_key_id
    ),
    grouped as (
      select ${grouping} as set_mask, ${id} as id, ${historySums(window)},
        null::float8 as "latencyP50Ms", null::float8 as "latencyP95Ms", null::float8 as "routerOverheadP95Ms",
        sum(tokens_in) + sum(tokens_out) as rank_tokens
      from labelled
      group by grouping sets ((), ${sets})
    ),
    ranked as (
      select *, row_number() over (partition by set_mask order by rank_tokens desc, id nulls last) as rn
      from grouped
    )
    select set_mask::int as "setMask", id, requests, attempts, errors, "tokensIn", "tokensOut",
      "cacheReadTokens", "cacheWriteTokens", "costMetered", "costNotional", "unpricedAttempts",
      "unpricedSince", "latencyP50Ms", "latencyP95Ms", "routerOverheadP95Ms"
    from ranked where set_mask = ${ALL} or rn <= ${limit}
    order by set_mask, rn`)

  const byMask = new Map<number, UsageGroupRow[]>()
  let totals: UsageTotals | undefined
  for (const { setMask, ...row } of rows) {
    const nested = nestUnpriced(row)
    if (setMask === ALL) {
      const {
        id: _id,
        latencyP50Ms: _p50,
        latencyP95Ms: _p95,
        routerOverheadP95Ms: _o,
        ...sums
      } = nested
      totals = sums
      continue
    }
    const group = byMask.get(setMask) ?? []
    group.push(nested)
    byMask.set(setMask, group)
  }
  if (totals === undefined) throw new Error("usage totals unavailable")
  const breakdowns = Object.fromEntries(
    COLUMNS.map(([dimension], index) => [dimension, byMask.get(maskOf(index)) ?? []]),
  ) as Record<UsageDimension, UsageGroupRow[]>
  return { totals, breakdowns }
}
