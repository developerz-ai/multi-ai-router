import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import type { RefreshFailure } from "./exchange"

export interface RefreshStatusDeps {
  readonly accounts: Pick<AccountRepository, "transitionObservedStatus">
  readonly refreshCatalogAfterMutation: () => Promise<void>
  readonly canFinalize?: () => boolean
  readonly audit: AuditRecorder
  readonly now: () => Date
}

/** Only an eligible still-observed row can be parked. No automatic revival from refresh. */
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

export function sameObservation(a: AccountRow, b: AccountRow): boolean {
  return (
    a.lifecycleVersion === b.lifecycleVersion &&
    a.authMaterial === b.authMaterial &&
    a.status === b.status
  )
}
