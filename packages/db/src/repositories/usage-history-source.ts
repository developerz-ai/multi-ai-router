import { type SQL, sql } from "drizzle-orm"
import { usageAttemptDailyV2, usageRequestDailyV2 } from "../schema/usage-aggregate-v2"
import { usageContributions } from "../schema/usage-contributions"
import { usageDaily } from "../schema/usage-daily"
import { usageHistoryState } from "../schema/usage-history-state"
import { andAll, filterConditions } from "./usage-filter"
import { payloadMeasures, unpricedSinceSql } from "./usage-history-shared"
import type { UsageFilter, UsageWindow } from "./usage-read-types"

const measures = [
  "requests",
  "attempts",
  "errors",
  "tokens_in",
  "tokens_out",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_metered",
  "cost_notional",
  "unpriced_attempts",
]
export const historyMeasures = measures
export const historyDimensions = {
  apiKeyId: "api_key_id",
  accountId: "account_id",
  poolId: "pool_id",
  model: "model",
  // Computed by the `labelled` relation in `usage-history-repository.ts`, not a stored column.
  owner: "grp",
  tool: "grp",
} as const
const dayMs = 86400000
/** Full days use materialized facts; exact partial edges use durable receipts, not retained raw. */
export function historySource(window: UsageWindow, hourly: boolean, filter: UsageFilter): SQL {
  // The predicate rides inside each of the four sources, so totals, breakdown and both series
  // read the same filtered facts and cannot disagree.
  const tableFilter = andAll(
    filterConditions(filter, {
      apiKeyId: sql`api_key_id`,
      accountId: sql`account_id`,
      poolId: sql`pool_id`,
      model: sql`model`,
    }),
  )
  const payloadFilter = andAll(
    filterConditions(filter, {
      apiKeyId: sql`(payload->>'apiKeyId')::uuid`,
      accountId: sql`(payload->>'accountId')::uuid`,
      poolId: sql`(payload->>'poolId')::uuid`,
      model: sql`payload->>'model'`,
    }),
  )
  const first = new Date(Math.ceil(window.from.getTime() / dayMs) * dayMs)
    .toISOString()
    .slice(0, 10)
  const end = new Date(Math.floor(window.to.getTime() / dayMs) * dayMs).toISOString().slice(0, 10)
  // The first and last UTC day any instant of the window can fall on. Every receipt the window
  // admits has `day` in [startDay, endDay] (its event-time is in [from, to)), so bounding the
  // contributions scan to that range drops no row the event-time filter would have kept — it only
  // stops `day_idx` from walking back to the retention horizon for the partial start edge.
  const startDay = new Date(Math.floor(window.from.getTime() / dayMs) * dayMs)
    .toISOString()
    .slice(0, 10)
  const endDay = new Date(Math.floor((window.to.getTime() - 1) / dayMs) * dayMs)
    .toISOString()
    .slice(0, 10)
  const horizon = sql`coalesce((select retention_before_day from ${usageHistoryState} where id = 'v2'), '-infinity'::date)`
  const since = unpricedSinceSql()
  // The unpriced measure counts only days on or after `since`, in every branch that can carry it —
  // a legacy-adopted pre-`since` day has the value but the day was never fully measured.
  const attemptProjection = sql`${sql.raw(measures.slice(0, 9).join(","))}, case when day >= ${since} then unpriced_attempts end as unpriced_attempts`
  const unmeasuredProjection = sql`${sql.raw(measures.slice(0, 9).join(","))}, null::numeric as unpriced_attempts`
  const parts: SQL[] = []
  if (!hourly) {
    const bounds = sql`where day >= ${first}::date and day < ${end}::date and day >= ${horizon} ${tableFilter}`
    for (const table of [usageDaily, usageRequestDailyV2])
      parts.push(
        sql`select day::timestamp at time zone 'UTC' as event_at, api_key_id, account_id, pool_id, model, ${unmeasuredProjection} from ${table} ${bounds}`,
      )
    parts.push(
      sql`select day::timestamp at time zone 'UTC' as event_at, api_key_id, account_id, pool_id, model, ${attemptProjection} from ${usageAttemptDailyV2} ${bounds}`,
    )
  }
  parts.push(sql`select (payload->>'eventAt')::timestamptz as event_at, (payload->>'apiKeyId')::uuid as api_key_id, (payload->>'accountId')::uuid as account_id, (payload->>'poolId')::uuid as pool_id, payload->>'model' as model,
    ${sql.join(
      payloadMeasures.map(
        (name, index) =>
          sql`(payload->>${name})::numeric as ${sql.identifier(measures[index] as string)}`,
      ),
      sql`, `,
    )}, case when day >= ${since} then (payload->>'unpricedAttempts')::numeric end as unpriced_attempts
    from ${usageContributions} where source in ('live','legacy_unbanked','legacy_overlap') and day >= ${horizon}
      and day >= ${startDay}::date and day <= ${endDay}::date
      and (payload->>'eventAt')::timestamptz >= ${window.from.toISOString()} and (payload->>'eventAt')::timestamptz < ${window.to.toISOString()}
      ${hourly ? sql`` : sql`and (day < ${first}::date or day >= ${end}::date)`}${payloadFilter}`)
  return sql.join(parts, sql` union all `)
}
export function historySums(window: UsageWindow) {
  const names = [
    "requests",
    "attempts",
    "errors",
    "tokensIn",
    "tokensOut",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costMetered",
    "costNotional",
  ]
  const since = unpricedSinceSql()
  // The last day any instant of the window can fall on: `to` is exclusive, so a window ending at
  // exact midnight never touches that day.
  const lastDay = new Date(Math.floor((window.to.getTime() - 1) / dayMs) * dayMs)
    .toISOString()
    .slice(0, 10)
  return sql.join(
    [
      ...measures
        .slice(0, 9)
        .map(
          (column, index) =>
            sql`coalesce(sum(${sql.identifier(column)}),0)${index < 7 ? sql`::float8` : sql`::text`} as ${sql.identifier(names[index] as string)}`,
        ),
      // Null only when the window lies wholly before measurement; a group with nothing measured
      // inside a window that reaches past `since` reads 0, because the window did measure.
      sql`(case when ${since} > ${lastDay}::date then null::float8 else coalesce(sum(${sql.identifier("unpriced_attempts")}),0) end)::float8 as "unpricedAttempts"`,
      sql`${since}::text as "unpricedSince"`,
    ],
    sql`, `,
  )
}
