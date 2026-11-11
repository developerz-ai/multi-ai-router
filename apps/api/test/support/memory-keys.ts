import {
  type ApiKeyAccountRow,
  ApiKeyNameTakenError,
  type ApiKeyPoolRow,
  type ApiKeyRow,
} from "@multi-ai-router/db"
import { drop, replace } from "./memory-row-operations"
import type { MemoryKeys } from "./memory-store-types"

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
): MemoryKeys {
  return {
    create: async (input) => {
      // The unique `api_keys(name)` index (0045), as the repository reports it.
      if (keys.some((row) => row.name === input.name)) throw new ApiKeyNameTakenError(input.name)
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
    // `value` dropped exactly as the SQL projection drops it, so a caller that starts reading the
    // ciphertext from a summary fails here too.
    listSummaries: async (filter) =>
      keys
        .filter(
          (row) =>
            (filter?.owner === undefined || row.owner === filter.owner) &&
            (filter?.tool === undefined || row.tool === filter.tool),
        )
        .map(({ value: _ciphertext, ...summary }) => summary),
    // The repository's usable predicate: prefix match, not revoked, unexpired at `now`.
    findUsableWithTargetsByPrefix: async (prefix, now) =>
      keys
        .filter(
          (row) =>
            row.prefix === prefix &&
            !row.revoked &&
            (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
        )
        .map((key) => ({
          key,
          poolIds: keyPools
            .filter((row) => row.apiKeyId === key.id)
            .sort(byPositionThenId)
            .map((row) => row.poolId),
          accountIds: keyAccounts
            .filter((row) => row.apiKeyId === key.id)
            .map((row) => row.accountId),
        })),
    findById: async (id) => keys.find((row) => row.id === id),
    findByName: async (name) => keys.find((row) => row.name === name),
    update: async (id, patch, now) => {
      if (patch.name !== undefined && keys.some((row) => row.name === patch.name && row.id !== id))
        throw new ApiKeyNameTakenError(patch.name)
      return replace(keys, id, patch, now)
    },
    markRevoked: async (id, now) => {
      replace(keys, id, { revoked: true, revokedAt: now }, now)
    },
    listPoolTargets: async (apiKeyId) =>
      keyPools.filter((row) => row.apiKeyId === apiKeyId).sort(byPositionThenId),
    listAccountTargets: async (apiKeyId) => keyAccounts.filter((row) => row.apiKeyId === apiKeyId),
    listTargetsForKeys: async (ids) => ({
      pools: keyPools.filter((row) => ids.includes(row.apiKeyId)).sort(byPositionThenId),
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

/** The real repository's read order: listed position, then row id. */
function byPositionThenId(
  a: { position: number; id: string },
  b: { position: number; id: string },
): number {
  return a.position - b.position || a.id.localeCompare(b.id)
}
