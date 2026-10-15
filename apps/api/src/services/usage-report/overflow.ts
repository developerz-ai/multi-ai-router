import type { UsageWeekRow } from "@multi-ai-router/db"
import type { ReportKeyLabel, ReportOverflowLine, ReportPool } from "./types"

/**
 * Overflow share per (service key K, pool P that has an overflow account).
 *
 * - numerator: K's attempts with `pool_id = P` on `P.overflow_account_id`
 * - denominator: K's attempts with `pool_id = P`
 *
 * Null-pool attempts (a preflight failure that never reached a pool) are in no ratio, a pool with
 * no overflow account yields no line, and only keys whose owner kind is `service` are reported:
 * a person's key on the overflow account is real spend but not the question this answers.
 *
 * There is no overflow marker on usage rows, so this is derived from where the attempts landed.
 * The pool's designation is read at generation time, not as it stood during the week; the report
 * says so in a caveat.
 */
export function overflowShares(
  rows: readonly UsageWeekRow[],
  labels: ReadonlyMap<string, ReportKeyLabel>,
  pools: readonly ReportPool[],
): ReportOverflowLine[] {
  const withOverflow = new Map(
    pools.filter((pool) => pool.overflowAccountId !== null).map((pool) => [pool.id, pool]),
  )
  const tally = new Map<
    string,
    { label: ReportKeyLabel; pool: ReportPool; overflow: number; attempts: number }
  >()
  for (const row of rows) {
    if (row.apiKeyId === null || row.poolId === null || row.attempts === 0) continue
    const pool = withOverflow.get(row.poolId)
    const label = labels.get(row.apiKeyId)
    if (pool === undefined || label === undefined || label.ownerKind !== "service") continue
    const key = `${row.apiKeyId}|${row.poolId}`
    const entry = tally.get(key) ?? { label, pool, overflow: 0, attempts: 0 }
    entry.attempts += row.attempts
    if (row.accountId === pool.overflowAccountId) entry.overflow += row.attempts
    tally.set(key, entry)
  }
  return [...tally.values()]
    .map(({ label, pool, overflow, attempts }) => ({
      keyName: label.name,
      owner: label.owner,
      ownerKind: label.ownerKind,
      tool: label.tool,
      poolName: pool.name,
      provider: pool.overflowProvider,
      overflowAttempts: overflow,
      attempts,
      share: overflow / attempts,
    }))
    .sort((a, b) => a.keyName.localeCompare(b.keyName) || a.poolName.localeCompare(b.poolName))
}
