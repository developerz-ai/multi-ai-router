import { and, asc, eq, getTableColumns, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { apiKeyAccounts, apiKeyPools } from "../schema/api-key-scope"
import { apiKeys } from "../schema/api-keys"
import { postgresFailure } from "./admin-mutation-conflict"
import { type ApiKeyListFilter, ApiKeyNameTakenError, type ApiKeyRepository } from "./api-key-types"

/** The repository's interface, inputs and row shapes live in `api-key-types.ts`. */
export {
  type ApiKeyListFilter,
  type ApiKeyListRow,
  ApiKeyNameTakenError,
  type ApiKeyRepository,
  type ApiKeyWithTargets,
  type CreateApiKeyInput,
  type ScopeTargetRows,
  type ScopeTargets,
  type UpdateApiKeyInput,
} from "./api-key-types"

/** Rethrows a unique violation on the name as {@link ApiKeyNameTakenError}; anything else as is. */
async function nameChecked<T>(name: string | undefined, write: Promise<T>): Promise<T> {
  try {
    return await write
  } catch (error) {
    const failure = postgresFailure(error)
    if (name !== undefined && failure?.code === "23505" && failure.constraint === NAME_KEY)
      throw new ApiKeyNameTakenError(name)
    throw error
  }
}
const NAME_KEY = "api_keys_name_key"

/** `undefined` (no WHERE) when the filter names nothing. Exact matches, ANDed. */
function listFilter(filter: ApiKeyListFilter | undefined): SQL | undefined {
  return and(
    filter?.owner === undefined ? undefined : eq(apiKeys.owner, filter.owner),
    filter?.tool === undefined ? undefined : eq(apiKeys.tool, filter.tool),
  )
}

export function createApiKeyRepository(db: DatabaseExecutor): ApiKeyRepository {
  const poolTargetsWhere = (where: SQL) =>
    db
      .select()
      .from(apiKeyPools)
      .where(where)
      .orderBy(asc(apiKeyPools.position), asc(apiKeyPools.id))

  const usableByPrefix = (prefix: string, now: Date) =>
    and(
      eq(apiKeys.prefix, prefix),
      eq(apiKeys.revoked, false),
      or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
    )

  return {
    findUsableByPrefix: (prefix, now) =>
      db.select().from(apiKeys).where(usableByPrefix(prefix, now)),

    // `array(subquery)` rather than a join + `array_agg`: it yields `{}` for a key with no targets
    // instead of a NULL or a duplicated key row, and each subquery rides its `(api_key_id, …)`
    // unique index. Spelled with explicit aliases because drizzle renders columns inside a select
    // field unqualified, which would turn the correlation into `api_key_id = id`. Cast to text so
    // the driver hands back plain strings.
    findUsableWithTargetsByPrefix: (prefix, now) =>
      db
        .select({
          key: apiKeys,
          poolIds: sql<
            string[]
          >`array(select p.pool_id::text from api_key_pools p where p.api_key_id = api_keys.id order by p.position, p.id)`,
          accountIds: sql<
            string[]
          >`array(select a.account_id::text from api_key_accounts a where a.api_key_id = api_keys.id)`,
        })
        .from(apiKeys)
        .where(usableByPrefix(prefix, now)),

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
      const rows = await nameChecked(
        input.name,
        db
          .insert(apiKeys)
          .values({
            name: input.name,
            value: input.value,
            prefix: input.prefix,
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            owner: input.owner ?? null,
            ownerKind: input.ownerKind ?? null,
            tool: input.tool ?? null,
            purpose: input.purpose ?? null,
            rateLimitRequests: input.rateLimitRequests ?? null,
            rateLimitWindowSeconds: input.rateLimitWindowSeconds ?? null,
            expiresAt: input.expiresAt ?? null,
          })
          .returning(),
      )
      const row = rows[0]
      if (row === undefined) throw new Error("apiKeyRepository.create: statement returned no row")
      return row
    },

    list: (filter) =>
      db.select().from(apiKeys).where(listFilter(filter)).orderBy(asc(apiKeys.createdAt)),

    listSummaries: (filter) => {
      const { value: _ciphertext, ...columns } = getTableColumns(apiKeys)
      return db
        .select(columns)
        .from(apiKeys)
        .where(listFilter(filter))
        .orderBy(asc(apiKeys.createdAt))
    },

    findByName: async (name) => {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.name, name)).limit(1)
      return rows[0]
    },

    // Spread-per-field: an absent key stays absent, `null` survives as an
    // explicit clear. `value` and `prefix` are deliberately not editable.
    update: async (id, patch, now) => {
      const rows = await nameChecked(
        patch.name,
        db
          .update(apiKeys)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.scope === undefined ? {} : { scope: patch.scope }),
            ...(patch.owner === undefined ? {} : { owner: patch.owner }),
            ...(patch.ownerKind === undefined ? {} : { ownerKind: patch.ownerKind }),
            ...(patch.tool === undefined ? {} : { tool: patch.tool }),
            ...(patch.purpose === undefined ? {} : { purpose: patch.purpose }),
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
          .returning(),
      )
      return rows[0]
    },

    listPoolTargets: (apiKeyId) => poolTargetsWhere(eq(apiKeyPools.apiKeyId, apiKeyId)),

    listAccountTargets: (apiKeyId) =>
      db.select().from(apiKeyAccounts).where(eq(apiKeyAccounts.apiKeyId, apiKeyId)),

    listTargetsForKeys: async (apiKeyIds) => {
      if (apiKeyIds.length === 0) return { pools: [], accounts: [] }
      const ids = [...apiKeyIds]
      const [poolRows, accountRows] = await Promise.all([
        poolTargetsWhere(inArray(apiKeyPools.apiKeyId, ids)),
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
          // The array index is the listed order — the delete-and-reinsert is where it is lost.
          await tx
            .insert(apiKeyPools)
            .values(poolIds.map((poolId, index) => ({ apiKeyId, poolId, position: index })))
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
