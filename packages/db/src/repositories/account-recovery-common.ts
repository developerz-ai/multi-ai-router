import { createHash } from "node:crypto"
import { and, eq, isNull, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries, type RecoveryReason } from "../schema/account-recoveries"
import { accounts } from "../schema/accounts"
import { quotaWindows } from "../schema/quota-windows"
export function credentialFingerprint(authMaterial: string | null): string {
  return createHash("sha256")
    .update(authMaterial === null ? "null:" : `cipher:${authMaterial}`)
    .digest("hex")
}
export async function recoveryClock(tx: DatabaseExecutor): Promise<Date> {
  const rows = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`)
  const value = rows[0]?.now
  if (value === undefined) throw new Error("recovery clock unavailable")
  return value instanceof Date ? value : new Date(value)
}
export async function lockAccount(tx: DatabaseExecutor, accountId: string) {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for("update")
  return account
}
export async function lockRecovery(tx: DatabaseExecutor, accountId: string) {
  const [held] = await tx
    .select()
    .from(accountRecoveries)
    .where(eq(accountRecoveries.accountId, accountId))
    .for("update")
  return held
}
/**
 * The quota evidence a recovery permit may bypass. A window whose reset the provider itself
 * reported and which has not arrived yet is the provider's own answer, not stale guesswork: only
 * a human "Re-check now" may spend a probe against it. Capturing it automatically sent a wasted,
 * certain-429 probe every cooldown for days (prod, 2026-10-06: two spent seven_day windows).
 */
export async function capturedQuota(
  tx: DatabaseExecutor,
  accountId: string,
  reason: RecoveryReason,
  now: Date,
): Promise<Record<string, number>> {
  const rows = await tx
    .select({
      window: quotaWindows.window,
      revision: quotaWindows.revision,
      resetSource: quotaWindows.resetSource,
      resetsAt: quotaWindows.resetsAt,
    })
    .from(quotaWindows)
    .where(
      and(
        eq(quotaWindows.accountId, accountId),
        eq(quotaWindows.evidenceState, "current"),
        isNull(quotaWindows.retiredAt),
      ),
    )
  const reported = (row: (typeof rows)[number]) =>
    row.resetSource === "provider-reported" &&
    row.resetsAt !== null &&
    row.resetsAt.getTime() > now.getTime()
  return Object.fromEntries(
    rows
      .filter((row) => reason === "operator-recheck" || !reported(row))
      .map((row) => [row.window, row.revision]),
  )
}
export function duration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("recovery duration must be positive safe integer")
}
