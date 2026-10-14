import type {
  ApiKeyAccountRow,
  ApiKeyPoolRow,
  ApiKeyRepository,
  ApiKeyRow,
} from "@multi-ai-router/db"
import { drop, remove, replace } from "./memory-row-operations"

/**
 * The admin-plane key store of `createMemoryStore`, over arrays — the same
 * methods and the same rules as the SQL repository (exact-match attribution
 * filters, spread-per-field updates, scope targets replaced as a whole set), so
 * a service under test exercises its real code path with no database involved.
 * Split out of `memory-store.ts` when the attribution columns arrived, to keep
 * that file inside the 300-line ceiling.
 */
export function memoryKeys(
  keys: ApiKeyRow[],
  keyPools: ApiKeyPoolRow[],
  keyAccounts: ApiKeyAccountRow[],
  epoch: Date,
): Pick<
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
> {
  return {
    create: async (input) => {
      const row: ApiKeyRow = {
        id: crypto.randomUUID(),
        name: input.name,
        value: input.value,
        prefix: input.prefix,
        scope: input.scope ?? "all",
        owner: input.owner ?? null,
        ownerKind: input.ownerKind ?? null,
        tool: input.tool ?? null,
        purpose: input.purpose ?? null,
        rateLimitRequests: input.rateLimitRequests ?? null,
        rateLimitWindowSeconds: input.rateLimitWindowSeconds ?? null,
        expiresAt: input.expiresAt ?? null,
        revoked: false,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: epoch,
        updatedAt: epoch,
      }
      keys.push(row)
      return row
    },
    // Exact matches, ANDed — mirroring the repository's predicates. A NULL label
    // matches nothing, the same as in SQL.
    list: async (filter) =>
      keys.filter(
        (row) =>
          (filter?.owner === undefined || row.owner === filter.owner) &&
          (filter?.tool === undefined || row.tool === filter.tool),
      ),
    findById: async (id) => keys.find((row) => row.id === id),
    findByName: async (name) => keys.find((row) => row.name === name),
    update: async (id, patch, now) => replace(keys, id, patch, now),
    delete: async (id) => remove(keys, id),
    markRevoked: async (id, now) => {
      replace(keys, id, { revoked: true, revokedAt: now }, now)
    },
    listPoolTargets: async (apiKeyId) => keyPools.filter((row) => row.apiKeyId === apiKeyId),
    listAccountTargets: async (apiKeyId) => keyAccounts.filter((row) => row.apiKeyId === apiKeyId),
    listTargetsForKeys: async (ids) => ({
      pools: keyPools.filter((row) => ids.includes(row.apiKeyId)),
      accounts: keyAccounts.filter((row) => ids.includes(row.apiKeyId)),
    }),
    listKeysScopedToPool: async (poolId) =>
      keyPools
        .filter((row) => row.poolId === poolId)
        .flatMap((row) => keys.filter((key) => key.id === row.apiKeyId)),
    listKeysScopedToAccount: async (accountId) =>
      keyAccounts
        .filter((row) => row.accountId === accountId)
        .flatMap((row) => keys.filter((key) => key.id === row.apiKeyId)),
    replaceScopeTargets: async (apiKeyId, targets) => {
      drop(keyPools, (row) => row.apiKeyId === apiKeyId)
      drop(keyAccounts, (row) => row.apiKeyId === apiKeyId)
      for (const [position, poolId] of (targets.poolIds ?? []).entries()) {
        keyPools.push({ id: crypto.randomUUID(), apiKeyId, poolId, position, createdAt: epoch })
      }
      for (const accountId of targets.accountIds ?? []) {
        keyAccounts.push({ id: crypto.randomUUID(), apiKeyId, accountId, createdAt: epoch })
      }
    },
  }
}
