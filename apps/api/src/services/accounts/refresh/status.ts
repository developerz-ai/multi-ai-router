import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import type { RefreshFailure } from "./exchange"

/**
 * The two status transitions a refresh is allowed to drive, and nothing else.
 *
 * They live apart from `./refresher.ts` because they are the part with an opinion about the
 * *account*, not about timers: which statuses a background process may overwrite, and what the
 * audit log should say about it. `../../health/claudeAuthProbe.ts` answers the same question for
 * Claude subscriptions and reaches the same two answers, which is the point — a router that parked
 * accounts differently depending on which background job noticed would be unexplainable.
 *
 * **`disabled` is never touched.** It is the operator's word, and a token that expired while an
 * account was switched off is not a reason to change what the operator decided.
 *
 * Neither writer invents an audit kind. Losing a credential is `account.updated` naming the reason;
 * regaining one is `account.reauthorized`, which already means exactly that.
 */

export interface RefreshStatusDeps {
  readonly accounts: Pick<AccountRepository, "updateStatus">
  readonly audit: AuditRecorder
  readonly now: () => Date
}

/** Parks an account whose refresh gave up. `false` when the row already said what this would say. */
export async function parkForReauth(
  deps: RefreshStatusDeps,
  row: AccountRow,
  reason: RefreshFailure,
): Promise<boolean> {
  if (row.status === "disabled" || row.status === "needs_reauth") return false

  await deps.accounts.updateStatus(row.id, "needs_reauth", deps.now())
  await deps.audit.record({
    kind: AUDIT_KINDS.accountUpdated,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: row.id,
    // Names and flags. `reason` is this module's own vocabulary, never the provider's words.
    detail: {
      provider: row.provider,
      source: "credential_refresh",
      status: "needs_reauth",
      previousStatus: row.status,
      reason,
    },
  })
  return true
}

/** A refresh that worked is proof the grant is live, so a parked account comes back to `active`. */
export async function reviveAfterRefresh(
  deps: RefreshStatusDeps,
  row: AccountRow,
): Promise<boolean> {
  if (row.status !== "needs_reauth") return false

  await deps.accounts.updateStatus(row.id, "active", deps.now())
  await deps.audit.record({
    kind: AUDIT_KINDS.accountReauthorized,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: row.id,
    detail: { provider: row.provider, source: "credential_refresh", previousStatus: row.status },
  })
  return true
}
