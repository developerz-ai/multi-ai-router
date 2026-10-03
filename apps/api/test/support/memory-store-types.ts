import type {
  AccountRepository,
  AccountRow,
  AdminMutationRepository,
  ApiKeyAccountRow,
  ApiKeyPoolRow,
  ApiKeyRepository,
  ApiKeyRow,
  AuditEventRow,
  AuditRepository,
  OauthStateRepository,
  OauthStateRow,
  PoolMemberRow,
  PoolRepository,
  PoolRow,
} from "@multi-ai-router/db"

export type MemoryAccounts = Pick<
  AccountRepository,
  | "saveRefreshedCredential"
  | "transitionObservedStatus"
  | "updateOperatorAccount"
  | "recheckAccount"
  | "recoverObservedAuthentication"
  | "confirmAccountAuthorization"
  | "beginAccountAuthorization"
  | "cancelAccountAuthorization"
  | "commitAuthorization"
  | "create"
  | "list"
  | "findById"
  | "findByIds"
  | "update"
  | "updateStatus"
  | "updateStatusWhen"
  | "disable"
  | "delete"
>

export type MemoryKeys = Pick<
  ApiKeyRepository,
  | "create"
  | "list"
  | "findById"
  | "findByName"
  | "update"
  | "delete"
  | "markRevoked"
  | "listPoolTargets"
  | "listAccountTargets"
  | "listTargetsForKeys"
  | "listKeysScopedToPool"
  | "listKeysScopedToAccount"
  | "replaceScopeTargets"
>

export interface MemoryStore {
  readonly mutations: AdminMutationRepository
  readonly accounts: MemoryAccounts
  readonly keys: MemoryKeys
  readonly pools: PoolRepository
  readonly oauthStates: OauthStateRepository
  readonly audit: Pick<AuditRepository, "append">
  /** The rows themselves, for assertions. */
  readonly rows: {
    readonly accounts: AccountRow[]
    readonly keys: ApiKeyRow[]
    readonly keyPools: ApiKeyPoolRow[]
    readonly keyAccounts: ApiKeyAccountRow[]
    readonly pools: PoolRow[]
    readonly poolMembers: PoolMemberRow[]
    readonly oauthStates: OauthStateRow[]
    readonly audit: AuditEventRow[]
  }
}
