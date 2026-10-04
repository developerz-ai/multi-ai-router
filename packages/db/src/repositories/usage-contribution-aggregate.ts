import { sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { usageAttemptDailyV2, usageRequestDailyV2 } from "../schema/usage-aggregate-v2"
import { usageContributions } from "../schema/usage-contributions"

export type ContributionRow = typeof usageContributions.$inferSelect
const columns = [
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
/** Input is ONLY newly admitted receipts. A retry never enters this additive statement. */
export async function applyUsageContributions(
  tx: DatabaseExecutor,
  rows: readonly ContributionRow[],
  repairDay?: string,
) {
  for (const kind of ["attempt", "terminal"] as const) {
    const accepted = rows.filter(
      (row) =>
        row.kind === kind &&
        (row.source === "live" ||
          row.source === "legacy_unbanked" ||
          row.source === "legacy_overlap"),
    )
    if (accepted.length === 0 && repairDay === undefined) continue
    const table = kind === "attempt" ? usageAttemptDailyV2 : usageRequestDailyV2
    const values = accepted.map((row) => ({
      ...row.payload,
      day: row.day,
      basis: row.source === "live" ? "live" : "legacy",
    }))
    const source =
      repairDay === undefined
        ? sql`select p from jsonb_array_elements(${JSON.stringify(values)}::jsonb) p`
        : sql`select payload || jsonb_build_object('day', day, 'basis', case when source = 'live' then 'live' else 'legacy' end) as p
        from ${usageContributions} where day = ${repairDay}::date and kind = ${kind} and source in ('live','legacy_unbanked','legacy_overlap')`
    const sum = (field: string) => sql.raw(`sum((p->>'${field}')::numeric)`)
    await tx.execute(sql`insert into ${table} (day, api_key_id, account_id, pool_id, model, basis, ${sql.raw(columns.join(","))})
      select (p->>'day')::date, (p->>'apiKeyId')::uuid, (p->>'accountId')::uuid, (p->>'poolId')::uuid, p->>'model', p->>'basis',
        ${sum("requests")}, ${sum("attempts")}, ${sum("errors")}, ${sum("tokensIn")}, ${sum("tokensOut")}, ${sum("cacheReadTokens")}, ${sum("cacheWriteTokens")}, ${sum("costMetered")}, ${sum("costNotional")}
      from (${source}) inputs
      group by 1,2,3,4,5,6
      on conflict (day, api_key_id, account_id, pool_id, model, basis) do update set
        ${sql.join(
          columns.map(
            (column) =>
              sql`${sql.identifier(column)} = ${table}.${sql.identifier(column)} + excluded.${sql.identifier(column)}`,
          ),
          sql`, `,
        )}, updated_at = clock_timestamp()`)
  }
}
