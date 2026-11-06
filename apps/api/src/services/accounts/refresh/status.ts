import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import type { RefreshFailure } from "./exchange"

export interface RefreshStatusDeps {
  readonly accounts: Pick<AccountRepository, "transitionObservedStatus" | "spendAuthRefresh">
  readonly refreshCatalogAfterMutation: () => Promise<void>
  readonly canFinalize?: () => boolean
  readonly audit: AuditRecorder
  readonly now: () => Date
}

/** Only an eligible still-observed row can be parked. The refresh it just failed is its one. */
export async function parkForReauth(
  deps: RefreshStatusDeps,
  row: AccountRow,
  reason: RefreshFailure,
): Promise<AccountRow | undefined> {
  if (row.status === "disabled" || row.status === "needs_reauth" || row.status === "exhausted")
    return undefined
  const committed = await deps.accounts.transitionObservedStatus({
    id: row.id,
    expected: {
      lifecycleVersion: row.lifecycleVersion,
      authMaterial: row.authMaterial,
      status: row.status,
    },
    status: "needs_reauth",
    now: deps.now(),
  })
  if (committed === undefined) return undefined
  if (committed.authMaterial !== null)
    await deps.accounts.spendAuthRefresh({
      id: committed.id,
      expectedAuthMaterial: committed.authMaterial,
      now: deps.now(),
    })
  if (deps.canFinalize?.() === false) return committed
  await deps.refreshCatalogAfterMutation()
  if (deps.canFinalize?.() === false) return committed
  await deps.audit.record({
    kind: AUDIT_KINDS.accountUpdated,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: committed.id,
    detail: {
      provider: committed.provider,
      source: "credential_refresh",
      status: committed.status,
      previousStatus: row.status,
      reason,
    },
  })
  return committed
}

/**
 * A parked account's one refresh failed, so `needs_reauth` sticks until a sign-in or an operator's
 * re-check. Undefined means the credential moved underneath this attempt: nothing was spent.
 */
export async function spendParkedRefresh(
  deps: RefreshStatusDeps,
  row: AccountRow & { readonly authMaterial: string },
  reason: RefreshFailure,
): Promise<AccountRow | undefined> {
  const spent = await deps.accounts.spendAuthRefresh({
    id: row.id,
    expectedAuthMaterial: row.authMaterial,
    now: deps.now(),
  })
  if (spent === undefined || deps.canFinalize?.() === false) return spent
  await deps.audit.record({
    kind: AUDIT_KINDS.accountUpdated,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: spent.id,
    detail: {
      provider: spent.provider,
      source: "credential_refresh",
      status: spent.status,
      previousStatus: row.status,
      reason,
    },
  })
  return spent
}

/** Same kind a sign-in or a healthy probe writes: this is a repair, not a first login. */
export async function auditRevival(
  deps: Pick<RefreshStatusDeps, "audit">,
  row: AccountRow,
): Promise<void> {
  await deps.audit.record({
    kind: AUDIT_KINDS.accountReauthorized,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: row.id,
    detail: {
      provider: row.provider,
      source: "credential_refresh",
      previousStatus: "needs_reauth",
      status: row.status,
    },
  })
}

export function sameObservation(a: AccountRow, b: AccountRow): boolean {
  return (
    a.lifecycleVersion === b.lifecycleVersion &&
    a.authMaterial === b.authMaterial &&
    a.status === b.status
  )
}
