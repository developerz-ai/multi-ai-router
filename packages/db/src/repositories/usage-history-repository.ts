import { type SQL, sql } from "drizzle-orm"
import type { Database } from "../client"
import { usageContributions } from "../schema/usage-contributions"
import { usageDaily } from "../schema/usage-daily"
import { usageHistoryState } from "../schema/usage-history-state"
import { usageRecords } from "../schema/usage-records"
import { attributionRelation, bucketSql, isAttributionDimension } from "./usage-attribution"
import { readUsageExportRows } from "./usage-export-repository"
import { dimensionIdType, groupIdsMatch } from "./usage-filter"
import { createUsageHistoryMaintenance } from "./usage-history-maintenance"
import {
  historyDimensions,
  historyMeasures,
  historySource,
  historySums,
} from "./usage-history-source"
import type { UsageHistoryCoverage, UsageHistoryRepository } from "./usage-history-types"
import {
  createUsageReadRepository,
  nestUnpriced,
  type UnpricedRow,
  type UsageDimension,
  type UsageFilter,
  type UsageGroupRow,
  type UsageGroupSeriesPoint,
  type UsageKeyAttribution,
  type UsageSeriesPoint,
  type UsageTotals,
  type UsageWindow,
} from "./usage-read-repository"
import { readUsageWeekRows } from "./usage-week-read"

/** `sum(m) as m` per measure — the fold projection, named so the outer sums read unchanged. */
const measureSums = (names: readonly string[]) =>
  sql.join(
    names.map((name) => sql`sum(${sql.identifier(name)}) as ${sql.identifier(name)}`),
    sql`, `,
  )

// What a series point carries; the breakdown fold carries all of `historyMeasures` instead.
const seriesMeasures = ["requests", "attempts", "errors", "tokens_in", "tokens_out"]

export function createUsageHistoryRepository(
  db: Database,
  inSnapshot = false,
): UsageHistoryRepository {
  const read = async <T>(query: ReturnType<typeof sql>) =>
    [...(await db.execute(query))] as unknown as T[]
  // Shared by `clock` and `coverage` so the earliest retained instant is computed byte-identically
  // either way: the window-resolution step reads only these two, never the heavier checks below.
  const boundsCte = sql`bounds as (select coalesce((select retention_before_day from ${usageHistoryState} where id='v2'),'-infinity'::date) as horizon)`
  // Always one row (left join), so a missing state row reads as "no watermark", not "no rows"; a
  // half-set pair (the CHECK forbids one) reads as no watermark too.
  const bankedCte = sql`banked as (select case when s.banked_through_id is null then null else s.banked_through_at end as at, case when s.banked_through_at is null then null else s.banked_through_id end as id from (select 1) one left join ${usageHistoryState} s on s.id='v2')`
  const firstReceiptCte = sql`first_receipt_day as (select day from ${usageContributions},bounds where day >= horizon order by day limit 1)`
  const earliestExpr = sql`least(
          (select day::timestamp at time zone 'UTC' from ${usageDaily},bounds where day >= horizon order by day limit 1),
          (select min((payload->>'eventAt')::timestamptz) from ${usageContributions} where day = (select day from first_receipt_day)),
          (select created_at from ${usageRecords},bounds where created_at >= (horizon::timestamp at time zone 'UTC') order by created_at limit 1)
        )`
  const clock = async (): Promise<Pick<UsageHistoryCoverage, "dbNow" | "earliestAt">> => {
    const [row] = await read<{ now: Date; earliest: Date | null }>(
      sql`with ${boundsCte}, ${firstReceiptCte} select clock_timestamp() as now, ${earliestExpr} as earliest`,
    )
    if (row === undefined) throw new Error("usage clock unavailable")
    return {
      dbNow: new Date(row.now),
      earliestAt: row.earliest === null ? null : new Date(row.earliest),
    }
  }
  const coverage = async (window?: UsageWindow): Promise<UsageHistoryCoverage> => {
    const from = window?.from ?? new Date(0),
      to = window?.to ?? new Date("9999-01-01")
    const [row] = await read<{
      now: Date
      earliest: Date | null
      rawFrom: Date | null
      rawTo: Date | null
      legacy: boolean
      pending: boolean
    }>(sql`
      with ${boundsCte},
      ${firstReceiptCte},
      ${bankedCte}
      select clock_timestamp() as now,
        ${earliestExpr} as earliest,
        (select min(created_at) from ${usageRecords} where created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}) as "rawFrom", (select max(created_at) from ${usageRecords} where created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}) as "rawTo",
        (exists(select 1 from ${usageDaily},bounds where day >= ${new Date(Math.floor(from.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date and day < ${new Date(Math.ceil(to.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date and day >= horizon)
          or exists(select 1 from ${usageContributions},bounds where day >= greatest(${new Date(Math.floor(from.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date,horizon) and day < ${new Date(Math.ceil(to.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date and source <> 'live' and (payload->>'eventAt')::timestamptz >= ${from.toISOString()} and (payload->>'eventAt')::timestamptz < ${to.toISOString()})) as legacy,
        exists(select 1 from ${usageRecords} r,bounds,banked where r.created_at >= greatest(${from.toISOString()}::timestamptz,(horizon::timestamp at time zone 'UTC'),coalesce(banked.at,'-infinity'::timestamptz)) and (banked.at is null or banked.id is null or (r.created_at,r.id) > (banked.at,banked.id)) and r.created_at < ${to.toISOString()} and not exists(select 1 from ${usageContributions} c where c.kind='attempt' and c.id=r.id and c.source<>'legacy_pending')) as pending`)
    if (row === undefined) throw new Error("usage coverage unavailable")
    return {
      dbNow: new Date(row.now),
      earliestAt: row.earliest === null ? null : new Date(row.earliest),
      rawFrom: row.rawFrom === null ? null : new Date(row.rawFrom),
      rawTo: row.rawTo === null ? null : new Date(row.rawTo),
      legacy: row.legacy,
      incomplete: row.legacy || row.pending,
      timeBasis: "event-time",
      requestsBasis: row.legacy || row.pending ? "mixed-legacy" : "terminal",
      historicalPrecision: "day",
    }
  }
  /**
   * The facts, and the relation to group them from. Owner and tool add a `labelled` step that joins
   * the injected key labels and computes the bucket as `grp`; every other dimension reads `facts`.
   * The attribution path requires a `fold` — a select over `facts` keyed by `api_key_id` — because
   * the label join runs AFTER the fold (#250): joined per fact row, it hash-probed every one of
   * ~400k window rows against the unnested labels and re-evaluated the bucket CASE before the
   * outer aggregate threw the grain away. Sums of sums are exact (sum of bigint is numeric), so
   * the outer aggregate over `labelled` reads identical totals.
   */
  const grouping = (
    window: UsageWindow,
    hourly: boolean,
    filter: UsageFilter,
    dimension: UsageDimension,
    attribution: UsageKeyAttribution | undefined,
    fold?: SQL,
  ) => {
    const facts = sql`facts as (${historySource(window, hourly, filter)})`
    if (!isAttributionDimension(dimension)) return { cte: facts, table: sql`facts` }
    if (fold === undefined) throw new Error("attribution grouping requires a fold")
    return {
      cte: sql`${facts}, folded as (${fold}), labelled as (select f.*, ${bucketSql(dimension, sql`f.api_key_id`)} as grp from folded f left join ${attributionRelation(attribution)} on m.id = f.api_key_id)`,
      table: sql`labelled`,
    }
  }
  const totals = async (window: UsageWindow, filter: UsageFilter) => {
    const [row] = await read<Omit<UsageTotals, "unpriced"> & UnpricedRow>(
      sql`with facts as (${historySource(window, false, filter)}) select ${historySums(window)} from facts`,
    )
    if (row === undefined) throw new Error("usage totals unavailable")
    return nestUnpriced(row)
  }
  const breakdown = async (
    window: UsageWindow,
    dimension: UsageDimension,
    requestedLimit: number | undefined,
    filter: UsageFilter,
    attribution?: UsageKeyAttribution,
  ) => {
    const limit = requestedLimit ?? 1000
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001)
      throw new Error("usage breakdown outside bounds")
    const { cte, table } = grouping(
      window,
      false,
      filter,
      dimension,
      attribution,
      isAttributionDimension(dimension)
        ? sql`select api_key_id, ${measureSums(historyMeasures)} from facts group by api_key_id`
        : undefined,
    )
    const rows = await read<Omit<UsageGroupRow, "unpriced"> & UnpricedRow>(
      sql`with ${cte} select ${sql.identifier(historyDimensions[dimension])}::text as id, ${historySums(window)}, null::float8 as "latencyP50Ms", null::float8 as "latencyP95Ms", null::float8 as "routerOverheadP95Ms" from ${table} group by ${sql.identifier(historyDimensions[dimension])} order by sum(tokens_in)+sum(tokens_out) desc, ${sql.identifier(historyDimensions[dimension])}::text nulls last limit ${limit}`,
    )
    return rows.map(nestUnpriced)
  }
  const seriesQuery = (
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageDimension | undefined,
    requestedWidth: number | undefined,
    ids: readonly (string | null)[] | undefined,
    filter: UsageFilter,
    attribution?: UsageKeyAttribution,
  ) => {
    const width = requestedWidth ?? 1
    if (!Number.isSafeInteger(width) || width < 1 || width > 1000000)
      throw new Error("usage series width outside bounds")
    const interval = `${width} ${bucket === "hour" ? "hours" : "days"}`
    const bucketAt = sql`date_bin(${interval}::interval, event_at, '1970-01-01 00:00:00+00'::timestamptz)`
    const attributed = dimension !== undefined && isAttributionDimension(dimension)
    const { cte, table } = grouping(
      window,
      bucket === "hour",
      filter,
      dimension ?? "apiKeyId",
      attribution,
      attributed
        ? sql`select ${bucketAt} as at, api_key_id, ${measureSums(seriesMeasures)} from facts group by 1, 2`
        : undefined,
    )
    // The attribution fold already bucketed `event_at`, so the outer read bins nothing and re-folds
    // to the bucket grain; every other path bins the fact rows directly.
    return sql`with ${cte} select to_char(${attributed ? sql`at` : bucketAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
      ${dimension === undefined ? sql`` : sql`${sql.identifier(historyDimensions[dimension])}::text as id,`} sum(requests)::float8 as requests, sum(attempts)::float8 as attempts, sum(errors)::float8 as errors,
      sum(tokens_in)::float8 as "tokensIn", sum(tokens_out)::float8 as "tokensOut"
      from ${table} ${
        dimension === undefined || ids === undefined
          ? sql``
          : sql`where ${groupIdsMatch(
              // sql.identifier is a Name chunk, not a SQL — the template wraps it into one.
              attributed ? sql`grp` : sql`${sql.identifier(historyDimensions[dimension])}`,
              dimensionIdType(dimension),
              ids,
            )}`
      } group by 1 ${dimension === undefined ? sql`` : sql`, 2`} order by 1`
  }
  // Declared apart from `repo` so the implementation signature (attribution optional) is checked
  // against both overloads of the interface instead of being contextually typed from them.
  const seriesByDimension = async (
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageDimension,
    width: number | undefined,
    ids: readonly (string | null)[] | undefined,
    filter: UsageFilter,
    attribution?: UsageKeyAttribution,
  ) =>
    read<UsageGroupSeriesPoint>(
      seriesQuery(window, bucket, dimension, width, ids, filter, attribution),
    )
  const repo: UsageHistoryRepository = {
    clock,
    coverage,
    totals,
    breakdown,
    exportRows: (window, filter, limit) => readUsageExportRows(db, window, filter, limit),
    weekRows: (window, ceiling) => readUsageWeekRows(db, window, ceiling),
    series: (window, bucket, width, filter) =>
      read<UsageSeriesPoint>(seriesQuery(window, bucket, undefined, width, undefined, filter)),
    seriesByDimension,
    withSnapshot: (callback) =>
      inSnapshot
        ? callback(repo, createUsageReadRepository(db))
        : db.transaction(
            (tx) =>
              callback(
                createUsageHistoryRepository(tx as unknown as Database, true),
                createUsageReadRepository(tx as unknown as Database),
              ),
            { isolationLevel: "repeatable read", accessMode: "read only" },
          ),
    ...createUsageHistoryMaintenance(db),
  }
  return repo
}
