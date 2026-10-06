import type { DatabaseExecutor } from "../client"
import {
  accountRecoveries,
  type RecoveryReason,
  type RecoveryRow,
} from "../schema/account-recoveries"
import type { AccountRow } from "../schema/accounts"
import {
  capturedQuota,
  credentialFingerprint,
  lockRecovery,
  recoveryClock,
} from "./account-recovery-common"
export async function replaceGeneration(
  tx: DatabaseExecutor,
  input: {
    accountId: string
    generationCandidate: string
    lifecycleVersion: number
    authMaterial: string | null
    reason: RecoveryReason
    cooldownMs: number
    ineligible?: boolean
    /** Born closed: no admission probe, only the generation bump that fences older observations. */
    settled?: boolean
  },
  held: RecoveryRow | undefined,
  now: Date,
) {
  const closed = input.ineligible === true || input.settled === true
  const values = {
    accountId: input.accountId,
    generation: input.generationCandidate,
    revision: (held?.revision ?? -1) + 1,
    lifecycleVersion: input.lifecycleVersion,
    credentialFingerprint: credentialFingerprint(input.authMaterial),
    state: closed ? ("cancelled" as const) : ("pending" as const),
    reason: input.reason,
    ownerBootId: null,
    ownershipEpoch: 0,
    preparationLeaseUntil: null,
    permitId: null,
    issuedAt: null,
    outcomeAt: closed ? now : null,
    requestedAt: now,
    nextAllowedAt: new Date(now.getTime() + input.cooldownMs),
    quotaRevisions: await capturedQuota(tx, input.accountId, input.reason, now),
  }
  const [row] = await tx
    .insert(accountRecoveries)
    .values(values)
    .onConflictDoUpdate({
      target: accountRecoveries.accountId,
      set: values,
    })
    .returning()
  if (row === undefined) throw new Error("begin recovery returned no row")
  return row
}

/**
 * Called after an account UPDATE holds its row lock, in the same transaction. Login, passive
 * authentication recovery, credential replacement and explicit enable each just proved (or an
 * operator just asserted) the account usable, so the generation is published already settled: a
 * pending one gated routing as `probe-in-flight` until a permit was issued on demand, refusing the
 * first requests after a reconnect (prod, 2026-10-06). `cancelled` is the only closed state the
 * permit check constraint admits without a permit. The cooldown still holds, so an operator check
 * finalizing on this transition joins it rather than opening a probe of its own.
 */
export async function publishAccountRecovery(
  tx: DatabaseExecutor,
  account: AccountRow,
  cooldownMs: number,
  reason: RecoveryReason,
): Promise<void> {
  const held = await lockRecovery(tx, account.id)
  const now = await recoveryClock(tx)
  await replaceGeneration(
    tx,
    {
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      lifecycleVersion: account.lifecycleVersion,
      authMaterial: account.authMaterial,
      cooldownMs,
      reason,
      settled: true,
    },
    held,
    now,
  )
}
