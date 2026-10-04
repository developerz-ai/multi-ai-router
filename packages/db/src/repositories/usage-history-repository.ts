import { sql } from "drizzle-orm"
import type { Database } from "../client"
import { usageContributions } from "../schema/usage-contributions"
import { usageDaily } from "../schema/usage-daily"
import { usageHistoryState } from "../schema/usage-history-state"
import { usageRecords } from "../schema/usage-records"
import { createUsageHistoryMaintenance } from "./usage-history-maintenance"
import { historyDimensions, historySource, historySums } from "./usage-history-source"
import type { UsageHistoryCoverage, UsageHistoryRepository } from "./usage-history-types"
import {
  createUsageReadRepository,
  type UsageDimension,
  type UsageGroupRow,
  type UsageGroupSeriesPoint,
  type UsageSeriesPoint,
  type UsageTotals,
  type UsageWindow,
} from "./usage-read-repository"

export function createUsageHistoryRepository(
  db: Database,
  inSnapshot = false,
): UsageHistoryRepository {
  const read = async <T>(query: ReturnType<typeof sql>) =>
    [...(await db.execute(query))] as unknown as T[]
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
      with bounds as (select coalesce((select retention_before_day from ${usageHistoryState} where id='v2'),'-infinity'::date) as horizon),
      first_receipt_day as (select day from ${usageContributions},bounds where day >= horizon order by day limit 1)
      select clock_timestamp() as now,
        least(
          (select day::timestamp at time zone 'UTC' from ${usageDaily},bounds where day >= horizon order by day limit 1),
          (select min((payload->>'eventAt')::timestamptz) from ${usageContributions} where day = (select day from first_receipt_day)),
          (select created_at from ${usageRecords},bounds where created_at >= (horizon::timestamp at time zone 'UTC') order by created_at limit 1)
        ) as earliest,
        (select min(created_at) from ${usageRecords} where created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}) as "rawFrom", (select max(created_at) from ${usageRecords} where created_at >= ${from.toISOString()} and created_at < ${to.toISOString()}) as "rawTo",
        (exists(select 1 from ${usageDaily},bounds where day >= ${new Date(Math.floor(from.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date and day < ${new Date(Math.ceil(to.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date and day >= horizon)
          or exists(select 1 from ${usageContributions},bounds where day >= greatest(${new Date(Math.floor(from.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date,horizon) and day < ${new Date(Math.ceil(to.getTime() / 86400000) * 86400000).toISOString().slice(0, 10)}::date and source <> 'live' and (payload->>'eventAt')::timestamptz >= ${from.toISOString()} and (payload->>'eventAt')::timestamptz < ${to.toISOString()})) as legacy,
        exists(select 1 from ${usageRecords} r,bounds where r.created_at >= greatest(${from.toISOString()}::timestamptz,(horizon::timestamp at time zone 'UTC')) and r.created_at < ${to.toISOString()} and not exists(select 1 from ${usageContributions} c where c.kind='attempt' and c.id=r.id and c.source<>'legacy_pending')) as pending`)
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
  const totals = async (window: UsageWindow) => {
    const [row] = await read<UsageTotals>(
      sql`with facts as (${historySource(window)}) select ${historySums()} from facts`,
    )
    if (row === undefined) throw new Error("usage totals unavailable")
    return row
  }
  const breakdown = (window: UsageWindow, dimension: UsageDimension, limit = 1000) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001)
      throw new Error("usage breakdown outside bounds")
    return read<UsageGroupRow>(
      sql`with facts as (${historySource(window)}) select ${sql.identifier(historyDimensions[dimension])}::text as id, ${historySums()}, null::float8 as "latencyP50Ms", null::float8 as "latencyP95Ms", null::float8 as "routerOverheadP95Ms" from facts group by ${sql.identifier(historyDimensions[dimension])} order by sum(tokens_in)+sum(tokens_out) desc, ${sql.identifier(historyDimensions[dimension])}::text nulls last limit ${limit}`,
    )
  }
  const seriesQuery = (
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension?: UsageDimension,
    width = 1,
    ids?: readonly (string | null)[],
  ) => {
    if (!Number.isSafeInteger(width) || width < 1 || width > 1000000)
      throw new Error("usage series width outside bounds")
    const interval = `${width} ${bucket === "hour" ? "hours" : "days"}`
    return sql`with facts as (${historySource(window, bucket === "hour")}) select to_char(date_bin(${interval}::interval, event_at, '1970-01-01 00:00:00+00'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
      ${dimension === undefined ? sql`` : sql`${sql.identifier(historyDimensions[dimension])}::text as id,`} sum(requests)::float8 as requests, sum(attempts)::float8 as attempts, sum(errors)::float8 as errors,
      sum(tokens_in)::float8 as "tokensIn", sum(tokens_out)::float8 as "tokensOut"
      from facts ${
        dimension === undefined || ids === undefined
          ? sql``
          : ids.length === 0
            ? sql`where false`
            : sql`where ${sql.join(
                ids.map(
                  (id) =>
                    sql`${sql.identifier(historyDimensions[dimension])}::text is not distinct from ${id}`,
                ),
                sql` or `,
              )}`
      } group by 1 ${dimension === undefined ? sql`` : sql`, 2`} order by 1`
  }
  const repo: UsageHistoryRepository = {
    coverage,
    totals,
    breakdown,
    series: (window, bucket, width) =>
      read<UsageSeriesPoint>(seriesQuery(window, bucket, undefined, width)),
    seriesByDimension: (window, bucket, dimension, width, ids) =>
      read<UsageGroupSeriesPoint>(seriesQuery(window, bucket, dimension, width, ids)),
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
