import type { KeyScope } from "@multi-ai-router/core"
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm"
import type { Database } from "../client"
import {
  type ApiKeyAccountRow,
  type ApiKeyPoolRow,
  apiKeyAccounts,
  apiKeyPools,
} from "../schema/api-key-scope"
import { type ApiKeyRow, apiKeys } from "../schema/api-keys"
import { deleteOldestBatch } from "./bounded-delete"

/**
 * Repositories own SQL. Services call these methods and never write a query
 * inline — this file is the only place that knows `api_keys`, `api_key_pools`,
 * and `api_key_accounts` are tables.
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
  findById(id: string): Promise<ApiKeyRow | undefined>
  markRevoked(id: string, now: Date): Promise<void>
  touchLastUsed(id: string, now: Date): Promise<void>

  // --- admin plane ----------------------------------------------------------
  create(input: CreateApiKeyInput): Promise<ApiKeyRow>
  /** Oldest first, so the admin list is stable across calls. */
  list(): Promise<ApiKeyRow[]>
  findByName(name: string): Promise<ApiKeyRow | undefined>
  /** Never touches `value` or `prefix`: editing a key does not rotate it. */
  update(id: string, patch: UpdateApiKeyInput, now: Date): Promise<ApiKeyRow | undefined>
  /** `true` when a row was removed. Scope rows cascade. */
  delete(id: string): Promise<boolean>
  /**
   * Purges keys revoked before `cutoff` in one bounded batch, oldest revocation
   * first, and returns how many went. Exactly `limit` means there is more to do
   * and the run should report `partial`.
   *
   * Revocation already excluded these keys from verification; this only reclaims
   * the rows a configured window later. Usage history survives —
   * `usage_records.api_key_id` is ON DELETE SET NULL — and scope rows cascade.
   *
   * A revoked row whose `revoked_at` is NULL has no measurable age and is never
   * swept, which is the safe reading: unpurged is recoverable, purged is not.
   */
  deleteRevokedOlderThan(cutoff: Date, limit: number): Promise<number>

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

export interface CreateApiKeyInput {
  /** Required, human-chosen: `sebastian-laptop`, `ci-agent-3`. */
  readonly name: string
  /** AES-256-GCM envelope of the full `mar_live_…` value. Never plaintext. */
  readonly value: string
  /** The clear, indexed display prefix — `routerKeyDisplayPrefix` in core. */
  readonly prefix: string
  readonly scope?: KeyScope
  readonly rateLimitRequests?: number | null
  readonly rateLimitWindowSeconds?: number | null
  readonly expiresAt?: Date | null
}

export interface UpdateApiKeyInput {
  readonly name?: string
  readonly scope?: KeyScope
  readonly rateLimitRequests?: number | null
  readonly rateLimitWindowSeconds?: number | null
  readonly expiresAt?: Date | null
}

/** Empty on both sides when the scope is `all`. */
export interface ScopeTargets {
  readonly poolIds?: readonly string[]
  readonly accountIds?: readonly string[]
}

export interface ScopeTargetRows {
  readonly pools: readonly ApiKeyPoolRow[]
  readonly accounts: readonly ApiKeyAccountRow[]
}

export function createApiKeyRepository(db: Database): ApiKeyRepository {
  return {
    findUsableByPrefix: (prefix, now) =>
      db
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.prefix, prefix),
            eq(apiKeys.revoked, false),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
          ),
        ),

    findById: async (id) => {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1)
      return rows[0]
    },

    markRevoked: async (id, now) => {
      await db
        .update(apiKeys)
        .set({ revoked: true, revokedAt: now, updatedAt: now })
        .where(eq(apiKeys.id, id))
    },

    touchLastUsed: async (id, now) => {
      await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id))
    },

    create: async (input) => {
      const rows = await db
        .insert(apiKeys)
        .values({
          name: input.name,
          value: input.value,
          prefix: input.prefix,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          rateLimitRequests: input.rateLimitRequests ?? null,
          rateLimitWindowSeconds: input.rateLimitWindowSeconds ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning()
      const row = rows[0]
      if (row === undefined) throw new Error("apiKeyRepository.create: statement returned no row")
      return row
    },

    list: () => db.select().from(apiKeys).orderBy(asc(apiKeys.createdAt)),

    findByName: async (name) => {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.name, name)).limit(1)
      return rows[0]
    },

    // Spread-per-field: an absent key stays absent, `null` survives as an
    // explicit clear. `value` and `prefix` are deliberately not editable.
    update: async (id, patch, now) => {
      const rows = await db
        .update(apiKeys)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.scope === undefined ? {} : { scope: patch.scope }),
          ...(patch.rateLimitRequests === undefined
            ? {}
            : { rateLimitRequests: patch.rateLimitRequests }),
          ...(patch.rateLimitWindowSeconds === undefined
            ? {}
            : { rateLimitWindowSeconds: patch.rateLimitWindowSeconds }),
          ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
          updatedAt: now,
        })
        .where(eq(apiKeys.id, id))
        .returning()
      return rows[0]
    },

    delete: async (id) => {
      const rows = await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id })
      return rows.length > 0
    },

    // Rides `api_keys_revoked_at_idx`. The `revoked` predicate is not redundant
    // with a non-null `revoked_at`: the flag is what `findUsableByPrefix` reads,
    // so narrowing on it means the sweep can only ever reach a key verification
    // already refuses — whatever a stray timestamp on a live row might say.
    deleteRevokedOlderThan: (cutoff, limit) =>
      deleteOldestBatch({
        db,
        table: apiKeys,
        id: apiKeys.id,
        agedBy: apiKeys.revokedAt,
        cutoff,
        limit,
        narrowedBy: eq(apiKeys.revoked, true),
      }),

    listPoolTargets: (apiKeyId) =>
      db.select().from(apiKeyPools).where(eq(apiKeyPools.apiKeyId, apiKeyId)),

    listAccountTargets: (apiKeyId) =>
      db.select().from(apiKeyAccounts).where(eq(apiKeyAccounts.apiKeyId, apiKeyId)),

    listTargetsForKeys: async (apiKeyIds) => {
      if (apiKeyIds.length === 0) return { pools: [], accounts: [] }
      const ids = [...apiKeyIds]
      const [poolRows, accountRows] = await Promise.all([
        db.select().from(apiKeyPools).where(inArray(apiKeyPools.apiKeyId, ids)),
        db.select().from(apiKeyAccounts).where(inArray(apiKeyAccounts.apiKeyId, ids)),
      ])
      return { pools: poolRows, accounts: accountRows }
    },

    listKeysScopedToPool: async (poolId) => {
      const rows = await db
        .select({ key: apiKeys })
        .from(apiKeyPools)
        .innerJoin(apiKeys, eq(apiKeys.id, apiKeyPools.apiKeyId))
        .where(eq(apiKeyPools.poolId, poolId))
      return rows.map((row) => row.key)
    },

    listKeysScopedToAccount: async (accountId) => {
      const rows = await db
        .select({ key: apiKeys })
        .from(apiKeyAccounts)
        .innerJoin(apiKeys, eq(apiKeys.id, apiKeyAccounts.apiKeyId))
        .where(eq(apiKeyAccounts.accountId, accountId))
      return rows.map((row) => row.key)
    },

    replaceScopeTargets: async (apiKeyId, targets) => {
      await db.transaction(async (tx) => {
        await tx.delete(apiKeyPools).where(eq(apiKeyPools.apiKeyId, apiKeyId))
        await tx.delete(apiKeyAccounts).where(eq(apiKeyAccounts.apiKeyId, apiKeyId))

        const poolIds = targets.poolIds ?? []
        if (poolIds.length > 0) {
          await tx.insert(apiKeyPools).values(poolIds.map((poolId) => ({ apiKeyId, poolId })))
        }

        const accountIds = targets.accountIds ?? []
        if (accountIds.length > 0) {
          await tx
            .insert(apiKeyAccounts)
            .values(accountIds.map((accountId) => ({ apiKeyId, accountId })))
        }
      })
    },
  }
}
