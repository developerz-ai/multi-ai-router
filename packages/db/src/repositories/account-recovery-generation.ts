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
  },
  held: RecoveryRow | undefined,
  now: Date,
) {
  const values = {
    accountId: input.accountId,
    generation: input.generationCandidate,
    revision: (held?.revision ?? -1) + 1,
    lifecycleVersion: input.lifecycleVersion,
    credentialFingerprint: credentialFingerprint(input.authMaterial),
    state: input.ineligible ? ("cancelled" as const) : ("pending" as const),
    reason: input.reason,
    ownerBootId: null,
    ownershipEpoch: 0,
    preparationLeaseUntil: null,
    permitId: null,
    issuedAt: null,
    outcomeAt: input.ineligible ? now : null,
    requestedAt: now,
    nextAllowedAt: new Date(now.getTime() + input.cooldownMs),
    quotaRevisions: await capturedQuota(tx, input.accountId),
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

/** Called after an account UPDATE holds its row lock, in the same transaction. */
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
      ineligible: account.status !== "active" && account.status !== "cooling_down",
    },
    held,
    now,
  )
}
