import { sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { usageAttemptDailyV2, usageRequestDailyV2 } from "../schema/usage-aggregate-v2"
import { usageContributions } from "../schema/usage-contributions"
import { payloadMeasures } from "./usage-history-shared"

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
/** Only the attempt table carries the unpriced measure; request-level rows carry no cost. */
const attemptColumns = [...columns, "unpriced_attempts"]
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
    // NULL only when no payload in the group carries the field, so a pre-measure day repairs to
    // NULL rather than to 0. On conflict the existing side is coalesced, never the incoming one,
    // so an unmeasured incoming batch (NULL) turns the stored value NULL: not measured wins. Only
    // field-less payloads from before the migration reach that, on days before `since`, which reads mask.
    const unpriced = sql`sum((p->>'unpricedAttempts')::numeric)`
    const measures =
      kind === "attempt" ? [...payloadMeasures.map(sum), unpriced] : payloadMeasures.map(sum)
    const names = kind === "attempt" ? attemptColumns : columns
    await tx.execute(sql`insert into ${table} (day, api_key_id, account_id, pool_id, model, basis, ${sql.raw(names.join(","))})
      select (p->>'day')::date, (p->>'apiKeyId')::uuid, (p->>'accountId')::uuid, (p->>'poolId')::uuid, p->>'model', p->>'basis',
        ${sql.join(measures, sql`, `)}
      from (${source}) inputs
      group by 1,2,3,4,5,6
      on conflict (day, api_key_id, account_id, pool_id, model, basis) do update set
        ${sql.join(
          names.map((column) =>
            column === "unpriced_attempts"
              ? sql`${sql.identifier(column)} = coalesce(${table}.${sql.identifier(column)}, 0) + excluded.${sql.identifier(column)}`
              : sql`${sql.identifier(column)} = ${table}.${sql.identifier(column)} + excluded.${sql.identifier(column)}`,
          ),
          sql`, `,
        )}, updated_at = clock_timestamp()`)
  }
}
