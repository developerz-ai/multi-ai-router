import type { AccountStatus, ResetSource } from "@multi-ai-router/core"
import { and, eq } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { type AccountBreakerRow, accountBreakers } from "../schema/account-breakers"
import type { AccountRow } from "../schema/accounts"
import { credentialFingerprint, lockAccount } from "./account-recovery-common"

export interface BreakerObservation {
  readonly accountId: string
  readonly expected: Pick<
    AccountRow,
    "lifecycleVersion" | "healthRecoveryVersion" | "authRecoveryVersion" | "authMaterial"
  >
  readonly observedRevision: number
  readonly status: AccountStatus
  readonly cooldownUntil?: Date
  readonly cooldownSource: ResetSource
  readonly cooldownReason?: "credential-rejected"
  readonly consecutiveFailures: number
}
export interface ProbeHoldObservation {
  readonly accountId: string
  readonly expected: BreakerObservation["expected"]
  /** The hold this replica takes; `null` releases. A later deadline than the stored one wins. */
  readonly probeHeldUntil: Date | null
  /**
   * The hold a `null` release is dropping, named by its own deadline. When it is given the row clears
   * only while it still stores exactly this deadline: another replica may have admitted its own probe
   * while this one was in flight, and clearing unconditionally would delete that live hold and hand a
   * third replica a gate that is still occupied. A release that names no hold (no token to release) is
   * an explicit clear of whatever is stored.
   */
  readonly releasedHeldUntil?: Date
}
export interface AccountBreakerRepository {
  observe(input: BreakerObservation): Promise<AccountBreakerRow | undefined>
  setProbeHold(input: ProbeHoldObservation): Promise<AccountBreakerRow | undefined>
}
export function currentBreaker(row: AccountBreakerRow, account: BreakerObservation["expected"]) {
  return (
    row.lifecycleVersion === account.lifecycleVersion &&
    row.healthRecoveryVersion === account.healthRecoveryVersion &&
    row.authRecoveryVersion === account.authRecoveryVersion &&
    row.credentialFingerprint === credentialFingerprint(account.authMaterial)
  )
}
/** Caller owns the account row lock, shared with lifecycle and recovery mutations. */
export async function effectiveBreaker(tx: DatabaseExecutor, account: AccountRow) {
  const [row] = await tx
    .select()
    .from(accountBreakers)
    .where(eq(accountBreakers.accountId, account.id))
  return row !== undefined && currentBreaker(row, account) ? row : undefined
}
export async function captureBreaker(
  tx: DatabaseExecutor,
  account: AccountRow,
  generation: string,
) {
  const row = await effectiveBreaker(tx, account)
  if (row !== undefined)
    await tx
      .update(accountBreakers)
      .set({ capturedGeneration: generation })
      .where(eq(accountBreakers.accountId, account.id))
}
export async function clearCapturedBreaker(
  tx: DatabaseExecutor,
  account: AccountRow,
  generation: string,
) {
  const row = await effectiveBreaker(tx, account)
  if (row?.capturedGeneration !== generation) return
  await tx
    .update(accountBreakers)
    .set({
      status: "active",
      cooldownUntil: null,
      cooldownSource: "unknown",
      cooldownReason: null,
      consecutiveFailures: 0,
      probeHeldUntil: null,
      revision: row.revision + 1,
      capturedGeneration: null,
    })
    .where(
      and(eq(accountBreakers.accountId, account.id), eq(accountBreakers.revision, row.revision)),
    )
}
export function createAccountBreakerRepository(db: DatabaseExecutor): AccountBreakerRepository {
  return {
    observe: (input) =>
      db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (
          account === undefined ||
          account.lifecycleVersion !== input.expected.lifecycleVersion ||
          account.healthRecoveryVersion !== input.expected.healthRecoveryVersion ||
          account.authRecoveryVersion !== input.expected.authRecoveryVersion ||
          account.authMaterial !== input.expected.authMaterial ||
          account.status === "disabled" ||
          account.status === "exhausted" ||
          account.status === "needs_reauth"
        )
          return undefined
        const [previous] = await tx
          .select()
          .from(accountBreakers)
          .where(eq(accountBreakers.accountId, input.accountId))
        const held =
          previous !== undefined && currentBreaker(previous, account) ? previous : undefined
        const success = input.status === "active" && input.consecutiveFailures === 0
        if (success && input.observedRevision !== (held?.revision ?? 0)) return undefined
        const parked = held?.status === "exhausted" || held?.status === "needs_reauth"
        if (parked && input.status !== held.status) return undefined
        const preserve = !success && input.status === "active" && held?.status === "cooling_down"
        const deadline = preserve
          ? (held.cooldownUntil ?? undefined)
          : input.status === "cooling_down"
            ? input.cooldownUntil
            : undefined
        if (input.status === "cooling_down" && deadline === undefined) return undefined
        const keep =
          held?.cooldownUntil !== null &&
          held?.cooldownUntil !== undefined &&
          deadline !== undefined &&
          held.cooldownUntil > deadline
        const values = {
          accountId: account.id,
          revision: (previous?.revision ?? 0) + 1,
          lifecycleVersion: account.lifecycleVersion,
          healthRecoveryVersion: account.healthRecoveryVersion,
          authRecoveryVersion: account.authRecoveryVersion,
          credentialFingerprint: credentialFingerprint(account.authMaterial),
          status: preserve ? held.status : input.status,
          cooldownUntil: keep ? held.cooldownUntil : (deadline ?? null),
          cooldownSource: keep || preserve ? held.cooldownSource : input.cooldownSource,
          cooldownReason: keep || preserve ? held.cooldownReason : (input.cooldownReason ?? null),
          consecutiveFailures: success
            ? 0
            : Math.max(held?.consecutiveFailures ?? 0, input.consecutiveFailures),
          // A hold belongs to a recovering account only: outside `cooling_down` the CHECK rejects
          // one, and a stale hold there would park a healthy account.
          probeHeldUntil:
            (preserve && held !== undefined ? held.status : input.status) === "cooling_down"
              ? (held?.probeHeldUntil ?? null)
              : null,
          capturedGeneration: null,
        }
        const [row] = await tx
          .insert(accountBreakers)
          .values(values)
          .onConflictDoUpdate({ target: accountBreakers.accountId, set: values })
          .returning()
        return row
      }),
    /**
     * Touches only the hold, so a probe taking or dropping one can never regress the clock. The
     * revision stays put: it fences a probe's success against a newer *verdict*, and a probe's own
     * hold moving it made every such success stale (prod 2026-11-23).
     */
    setProbeHold: (input) =>
      db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (
          account === undefined ||
          account.lifecycleVersion !== input.expected.lifecycleVersion ||
          account.healthRecoveryVersion !== input.expected.healthRecoveryVersion ||
          account.authRecoveryVersion !== input.expected.authRecoveryVersion ||
          account.authMaterial !== input.expected.authMaterial ||
          account.status === "disabled" ||
          account.status === "exhausted" ||
          account.status === "needs_reauth"
        )
          return undefined
        const [previous] = await tx
          .select()
          .from(accountBreakers)
          .where(eq(accountBreakers.accountId, input.accountId))
        if (previous === undefined || !currentBreaker(previous, account)) return undefined
        if (previous.status !== "cooling_down") return undefined
        const incoming = input.probeHeldUntil
        const held = previous.probeHeldUntil
        const released = input.releasedHeldUntil
        // A release naming its own hold leaves a later one alone; a tokenless release clears.
        const next =
          incoming === null
            ? released === undefined || (held !== null && held.getTime() === released.getTime())
              ? null
              : held
            : held !== null && held > incoming
              ? held
              : incoming
        if (next?.getTime() === held?.getTime()) return previous
        const [row] = await tx
          .update(accountBreakers)
          .set({ probeHeldUntil: next })
          .where(
            and(
              eq(accountBreakers.accountId, input.accountId),
              eq(accountBreakers.revision, previous.revision),
            ),
          )
          .returning()
        return row
      }),
  }
}
