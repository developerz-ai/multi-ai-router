import { describeError } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"

export type DeletionCleanup = "removed" | "deferred" | "not_applicable"

interface DeletedAccount {
  readonly id: string
  readonly configDir: string | null
}

/** What deleting a committed account still owes outside its row. */
export interface AccountDeletionDeps {
  /** Publish durable filesystem tombstone and close account owner admission before the barrier. */
  readonly revokeDeletedAccount: (account: DeletedAccount) => Promise<void>
  /** Strict deletion barrier: remove catalog/session admission after durable delete. */
  readonly deletionCommitted: (accountId: string) => Promise<void>
  /** Shared-volume authority cancels owners and removes only under exclusive ownership. */
  readonly cleanupDeletedAccount: (account: DeletedAccount) => Promise<DeletionCleanup>
  readonly audit: AuditRecorder
  readonly log?: Pick<Logger, "warn">
}

/**
 * Everything after the row is gone. Nothing here can undo the delete, so nothing here may lose its
 * audit row either: the account's directory is best effort (`config_dir_reap` removes what is left,
 * under its ownership fence), and the routing barrier's failure is raised only once the rest ran.
 *
 * Only a subscription account owns a directory, and only it holds a replica lease. Asking the lease
 * to revoke any other account refuses.
 */
export async function finishAccountDeletion(
  deps: AccountDeletionDeps,
  account: Pick<AccountRow, "id" | "label" | "provider" | "configDir">,
  pools: readonly { readonly poolId: string; readonly name: string | null }[],
): Promise<DeletionCleanup> {
  const target = { id: account.id, configDir: account.configDir }
  const deferred = (error: unknown): "deferred" => {
    deps.log?.warn("deleted account's directory was not revoked; the reaper will remove it", {
      component: "accounts",
      accountId: account.id,
      reason: describeError(error, 200),
    })
    return "deferred"
  }

  let cleanup: DeletionCleanup = "not_applicable"
  if (target.configDir !== null) {
    cleanup = "removed"
    try {
      await deps.revokeDeletedAccount(target)
    } catch (error) {
      cleanup = deferred(error)
    }
  }

  // Even a filesystem tombstone failure must not leave a deleted row locally routable.
  const barrier = await deps.deletionCommitted(account.id).then(
    () => null,
    (error: unknown) => ({ error }),
  )

  // Cleanup precedes optional audit work. Deferred cleanup keeps owned credentials intact;
  // durable deletion already prevents a late credential CAS from resurrecting the account.
  if (cleanup === "removed") cleanup = await deps.cleanupDeletedAccount(target).catch(deferred)

  await deps.audit.record({
    kind: AUDIT_KINDS.accountDeleted,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: account.id,
    detail: { label: account.label, provider: account.provider, pools },
  })
  if (barrier !== null) throw barrier.error
  return cleanup
}

/** The keys whose scope a delete would narrow. A revoked key reaches nothing, so it blocks nothing. */
export function liveKeyNames(
  keys: readonly { readonly name: string; readonly revoked: boolean }[],
): readonly string[] {
  return keys.filter((key) => !key.revoked).map((key) => `"${key.name}"`)
}
