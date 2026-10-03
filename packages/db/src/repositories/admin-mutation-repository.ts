import { eq, sql } from "drizzle-orm"
import { advisoryLockKey } from "../advisory-lock"
import type { Database } from "../client"
import { apiKeys } from "../schema/api-keys"
import { pools } from "../schema/pools"
import { type AccountRepository, createAccountRepository } from "./account-repository"
import { withAdminMutationRetry } from "./admin-mutation-conflict"
import { type ApiKeyRepository, createApiKeyRepository } from "./api-key-repository"
import { type AuditRepository, createAuditRepository } from "./audit-repository"
import { createPoolRepository, type PoolRepository } from "./pool-repository"

export interface AdminMutationSubject {
  readonly kind: "key" | "pool"
  readonly id: string | null
  /** Required for create/rename: API name uniqueness is serialized before checking for a clash. */
  readonly name?: string
}

export interface AdminMutationScope {
  readonly keys: Pick<
    ApiKeyRepository,
    | "create"
    | "findById"
    | "findByName"
    | "update"
    | "delete"
    | "markRevoked"
    | "listPoolTargets"
    | "listAccountTargets"
    | "listKeysScopedToPool"
    | "replaceScopeTargets"
  >
  readonly pools: PoolRepository
  readonly accounts: Pick<AccountRepository, "list" | "findByIds">
  readonly audit: Pick<AuditRepository, "append">
}

export interface AdminMutationRepository {
  run<T>(subject: AdminMutationSubject, work: (scope: AdminMutationScope) => Promise<T>): Promise<T>
}

// Separate from scheduler locks. Hash collisions only serialize unrelated names.
const ADMIN_NAME_LOCK_CLASS = 0x6164_6d6e

/** All callbacks use one connection; none of their repositories can escape to the outer pool. */
export function createAdminMutationRepository(db: Database): AdminMutationRepository {
  return {
    run: (subject, work) =>
      withAdminMutationRetry(() =>
        db.transaction(async (tx) => {
          // Name before row is the common order for create/rename. Low-level repository callers
          // remain responsible for their own uniqueness checks; existing duplicate names are kept.
          if (subject.name !== undefined) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(${ADMIN_NAME_LOCK_CLASS}, ${advisoryLockKey(`${subject.kind}:${subject.name}`)})`,
            )
          }
          if (subject.id !== null) {
            if (subject.kind === "key") {
              await tx
                .select({ id: apiKeys.id })
                .from(apiKeys)
                .where(eq(apiKeys.id, subject.id))
                .for("update")
            } else {
              // Also conflicts with FK key-share locks: deletion cannot silently remove a scope
              // inserted after the service checks which keys still reference this pool.
              await tx
                .select({ id: pools.id })
                .from(pools)
                .where(eq(pools.id, subject.id))
                .for("update")
            }
          }
          return work({
            keys: createApiKeyRepository(tx),
            pools: createPoolRepository(tx),
            accounts: createAccountRepository(tx),
            audit: createAuditRepository(tx),
          })
        }),
      ),
  }
}
