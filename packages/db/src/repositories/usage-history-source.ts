import { type SQL, sql } from "drizzle-orm"
import { usageAttemptDailyV2, usageRequestDailyV2 } from "../schema/usage-aggregate-v2"
import { usageContributions } from "../schema/usage-contributions"
import { usageDaily } from "../schema/usage-daily"
import { usageHistoryState } from "../schema/usage-history-state"
import type { UsageWindow } from "./usage-read-repository"

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
]
export const historyMeasures = measures
export const historyDimensions = {
  apiKeyId: "api_key_id",
  accountId: "account_id",
  poolId: "pool_id",
  model: "model",
} as const
const dayMs = 86400000
/** Full days use materialized facts; exact partial edges use durable receipts, not retained raw. */
export function historySource(window: UsageWindow, hourly = false): SQL {
  const first = new Date(Math.ceil(window.from.getTime() / dayMs) * dayMs)
    .toISOString()
    .slice(0, 10)
  const end = new Date(Math.floor(window.to.getTime() / dayMs) * dayMs).toISOString().slice(0, 10)
  const horizon = sql`coalesce((select retention_before_day from ${usageHistoryState} where id = 'v2'), '-infinity'::date)`
  const parts: SQL[] = []
  if (!hourly) {
    for (const table of [usageDaily, usageAttemptDailyV2, usageRequestDailyV2])
      parts.push(
        sql`select day::timestamp at time zone 'UTC' as event_at, api_key_id, account_id, pool_id, model, ${sql.raw(measures.join(","))} from ${table} where day >= ${first}::date and day < ${end}::date and day >= ${horizon}`,
      )
  }
  const jsonMeasures = [
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
  parts.push(sql`select (payload->>'eventAt')::timestamptz as event_at, (payload->>'apiKeyId')::uuid as api_key_id, (payload->>'accountId')::uuid as account_id, (payload->>'poolId')::uuid as pool_id, payload->>'model' as model,
    ${sql.join(
      jsonMeasures.map(
        (name, index) =>
          sql`(payload->>${name})::numeric as ${sql.identifier(measures[index] as string)}`,
      ),
      sql`, `,
    )}
    from ${usageContributions} where source in ('live','legacy_unbanked','legacy_overlap') and day >= ${horizon}
      and (payload->>'eventAt')::timestamptz >= ${window.from.toISOString()} and (payload->>'eventAt')::timestamptz < ${window.to.toISOString()}
      ${hourly ? sql`` : sql`and (day < ${first}::date or day >= ${end}::date)`}`)
  return sql.join(parts, sql` union all `)
}
export function historySums() {
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
  return sql.join(
    measures.map(
      (column, index) =>
        sql`coalesce(sum(${sql.identifier(column)}),0)${index < 7 ? sql`::float8` : sql`::text`} as ${sql.identifier(names[index] as string)}`,
    ),
    sql`, `,
  )
}
