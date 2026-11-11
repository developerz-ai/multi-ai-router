import type { KeyOwnerKind, KeyScope } from "@multi-ai-router/core"
import type { ApiKeyAccountRow, ApiKeyPoolRow } from "../schema/api-key-scope"
import type { ApiKeyRow } from "../schema/api-keys"

/**
 * Repositories own SQL. Services call these methods and never write a query
 * inline — `api-key-repository.ts` is the only place that knows `api_keys`,
 * `api_key_pools`, and `api_key_accounts` are tables.
 *
 * The verification lookup is a cache *miss* path: the data plane answers from a
 * warm in-memory cache and only lands here on a miss, as a single indexed query.
 *
 * **Ciphertext in, ciphertext out.** `value` crosses this boundary as the
 * AES-256-GCM envelope; encryption and the constant-time comparison both happen
 * above. Keys are encrypted rather than hashed on purpose — the admin can
 * decrypt and re-copy one at any time, and there is no shown-once flow anywhere
 * (docs/idea/04-api-keys-and-access.md#key-visibility--encrypted-not-hashed).
 */
export interface ApiKeyRepository {
  /**
   * Rows whose display prefix matches and that are still usable at `now`.
   * A prefix is not unique by construction, so the caller decrypts each
   * candidate and compares in constant time — the index narrows, it never decides.
   */
  findUsableByPrefix(prefix: string, now: Date): Promise<ApiKeyRow[]>
  /**
   * {@link ApiKeyRepository.findUsableByPrefix} with each candidate's scope targets folded in, as
   * one statement: a scoped key's cache miss used to cost the prefix query plus two membership
   * queries. Pool ids keep the scope's listed order (`position`, then id); account ids are
   * unordered. Both arrays are empty for a key whose scope is `all`.
   */
  findUsableWithTargetsByPrefix(prefix: string, now: Date): Promise<ApiKeyWithTargets[]>
  findById(id: string): Promise<ApiKeyRow | undefined>
  markRevoked(id: string, now: Date): Promise<void>
  touchLastUsed(id: string, now: Date): Promise<void>

  // --- admin plane ----------------------------------------------------------
  /** Throws {@link ApiKeyNameTakenError} when the name is in use. */
  create(input: CreateApiKeyInput): Promise<ApiKeyRow>
  /** Oldest first, so the admin list is stable across calls. Filters are exact matches, ANDed. */
  list(filter?: ApiKeyListFilter): Promise<ApiKeyRow[]>
  /**
   * {@link ApiKeyRepository.list} without `value`: every reader of the list (the admin keys
   * table, recovery reach, usage labels) renders or filters metadata, and the ciphertext belongs
   * to the reveal path (`findById`) alone.
   */
  listSummaries(filter?: ApiKeyListFilter): Promise<ApiKeyListRow[]>
  findByName(name: string): Promise<ApiKeyRow | undefined>
  /**
   * Never touches `value` or `prefix`: editing a key does not rotate it. Throws
   * {@link ApiKeyNameTakenError} when a rename collides.
   */
  update(id: string, patch: UpdateApiKeyInput, now: Date): Promise<ApiKeyRow | undefined>
  // There is deliberately no `delete`: removing an `api_keys` row writes a tombstone in the same
  // statement, and that lives in `ApiKeyTombstoneRepository` (`deleteKey`, `purgeRevoked`).

  listPoolTargets(apiKeyId: string): Promise<ApiKeyPoolRow[]>
  listAccountTargets(apiKeyId: string): Promise<ApiKeyAccountRow[]>
  /** All scope rows for a set of keys, for the admin list view. */
  listTargetsForKeys(apiKeyIds: readonly string[]): Promise<ScopeTargetRows>
  /** Keys whose scope names this pool — what a pool deletion would silently narrow. */
  listKeysScopedToPool(poolId: string): Promise<ApiKeyRow[]>
  /** Keys whose scope names this account. */
  listKeysScopedToAccount(accountId: string): Promise<ApiKeyRow[]>
  /**
   * Scope targets are replaced as a whole set inside one transaction: a key is
   * never briefly scoped to nothing, which on the data plane would read as a
   * scope violation rather than an edit in progress.
   */
  replaceScopeTargets(apiKeyId: string, targets: ScopeTargets): Promise<void>
}

/**
 * Another key already has this name (`api_keys_name_key`, 0045). The admin service normally
 * answers a clash before it writes; this is the same answer for a writer that raced it or never
 * asked.
 */
export class ApiKeyNameTakenError extends Error {
  override readonly name = "ApiKeyNameTakenError"
  constructor(readonly keyName: string) {
    super(`a key named "${keyName}" already exists`)
  }
}

export interface CreateApiKeyInput {
  /** Required, human-chosen: `sebastian-laptop`, `ci-agent-3`. */
  readonly name: string
  /** AES-256-GCM envelope of the full `mar_live_…` value. Never plaintext. */
  readonly value: string
  /** The clear, indexed display prefix — `routerKeyDisplayPrefix` in core. */
  readonly prefix: string
  readonly scope?: KeyScope
  /** Attribution labels — usage reporting only, never read on the request path. */
  readonly owner?: string | null
  readonly ownerKind?: KeyOwnerKind | null
  readonly tool?: string | null
  readonly purpose?: string | null
  readonly rateLimitRequests?: number | null
  readonly rateLimitWindowSeconds?: number | null
  readonly expiresAt?: Date | null
}

export interface UpdateApiKeyInput {
  readonly name?: string
  readonly scope?: KeyScope
  readonly owner?: string | null
  readonly ownerKind?: KeyOwnerKind | null
  readonly tool?: string | null
  readonly purpose?: string | null
  readonly rateLimitRequests?: number | null
  readonly rateLimitWindowSeconds?: number | null
  readonly expiresAt?: Date | null
}

/** Attribution filters for the admin list. Exact match; both may combine. */
export interface ApiKeyListFilter {
  readonly owner?: string
  readonly tool?: string
}

/** Empty on both sides when the scope is `all`. */
export interface ScopeTargets {
  readonly poolIds?: readonly string[]
  readonly accountIds?: readonly string[]
}

/** An `api_keys` row without the encrypted `value`. */
export type ApiKeyListRow = Omit<ApiKeyRow, "value">

export interface ApiKeyWithTargets {
  readonly key: ApiKeyRow
  readonly poolIds: readonly string[]
  readonly accountIds: readonly string[]
}

export interface ScopeTargetRows {
  readonly pools: readonly ApiKeyPoolRow[]
  readonly accounts: readonly ApiKeyAccountRow[]
}
