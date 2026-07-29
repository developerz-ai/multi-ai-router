import type {
  AccountRepository,
  AccountRow,
  ApiKeyAccountRow,
  ApiKeyPoolRow,
  ApiKeyRepository,
  ApiKeyRow,
  AuditEventRow,
  OauthStateRepository,
  OauthStateRow,
  PoolMemberRow,
  PoolRepository,
  PoolRow,
} from "@multi-ai-router/db"
import type { AuditSink } from "../../src/services/admin"

/**
 * In-memory stands-in for the stores the admin services depend on.
 *
 * These are not mocks with expectations — they are the smallest honest
 * implementation of the same interfaces, so a service under test exercises its
 * real code path and the test asserts on rows rather than on calls. No database
 * is involved, which is what lets the admin API's unit *and* integration tests
 * run with no `DATABASE_URL`.
 */

export type MemoryAccounts = Pick<
  AccountRepository,
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
  readonly accounts: MemoryAccounts
  readonly keys: MemoryKeys
  readonly pools: PoolRepository
  readonly oauthStates: OauthStateRepository
  readonly audit: AuditSink
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

const EPOCH = new Date("2026-07-24T12:00:00.000Z")

export function createMemoryStore(): MemoryStore {
  const accounts: AccountRow[] = []
  const keys: ApiKeyRow[] = []
  const keyPools: ApiKeyPoolRow[] = []
  const keyAccounts: ApiKeyAccountRow[] = []
  const pools: PoolRow[] = []
  const poolMembers: PoolMemberRow[] = []
  const oauthStates: OauthStateRow[] = []
  const audit: AuditEventRow[] = []

  return {
    rows: { accounts, keys, keyPools, keyAccounts, pools, poolMembers, oauthStates, audit },

    accounts: {
      create: async (input) => {
        const row: AccountRow = {
          id: input.id ?? crypto.randomUUID(),
          label: input.label,
          provider: input.provider,
          status: input.status ?? "active",
          authMaterial: input.authMaterial ?? null,
          configDir: input.configDir ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          baseUrl: input.baseUrl ?? null,
          dialect: input.dialect ?? null,
          modelAliases: input.modelAliases ?? null,
          supportedModels: input.supportedModels ?? null,
          weight: input.weight ?? 100,
          priority: input.priority ?? 0,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        }
        accounts.push(row)
        return row
      },
      list: async (filter) =>
        accounts.filter(
          (row) =>
            (filter?.status === undefined || row.status === filter.status) &&
            (filter?.provider === undefined || row.provider === filter.provider),
        ),
      findById: async (id) => accounts.find((row) => row.id === id),
      findByIds: async (ids) => accounts.filter((row) => ids.includes(row.id)),
      update: async (id, patch, now) => replace(accounts, id, patch, now),
      updateStatus: async (id, status, now) => replace(accounts, id, { status }, now),
      // The guard, honestly: the point of this method is that it does *not* apply when the row
      // holds something outside `from`, and a stand-in that always wrote would let a test pass on
      // a repository that overwrote the operator's `disabled`.
      updateStatusWhen: async (id, from, to, now) => {
        const row = accounts.find((candidate) => candidate.id === id)
        if (row === undefined || !from.includes(row.status)) return undefined
        return replace(accounts, id, { status: to }, now)
      },
      disable: async (id, now) => replace(accounts, id, { status: "disabled" }, now),
      delete: async (id) => remove(accounts, id),
    },

    keys: {
      create: async (input) => {
        const row: ApiKeyRow = {
          id: crypto.randomUUID(),
          name: input.name,
          value: input.value,
          prefix: input.prefix,
          scope: input.scope ?? "all",
          rateLimitRequests: input.rateLimitRequests ?? null,
          rateLimitWindowSeconds: input.rateLimitWindowSeconds ?? null,
          expiresAt: input.expiresAt ?? null,
          revoked: false,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        }
        keys.push(row)
        return row
      },
      list: async () => [...keys],
      findById: async (id) => keys.find((row) => row.id === id),
      findByName: async (name) => keys.find((row) => row.name === name),
      update: async (id, patch, now) => replace(keys, id, patch, now),
      delete: async (id) => remove(keys, id),
      markRevoked: async (id, now) => {
        replace(keys, id, { revoked: true, revokedAt: now }, now)
      },
      listPoolTargets: async (apiKeyId) => keyPools.filter((row) => row.apiKeyId === apiKeyId),
      listAccountTargets: async (apiKeyId) =>
        keyAccounts.filter((row) => row.apiKeyId === apiKeyId),
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
        for (const poolId of targets.poolIds ?? []) {
          keyPools.push({ id: crypto.randomUUID(), apiKeyId, poolId, createdAt: EPOCH })
        }
        for (const accountId of targets.accountIds ?? []) {
          keyAccounts.push({ id: crypto.randomUUID(), apiKeyId, accountId, createdAt: EPOCH })
        }
      },
    },

    pools: {
      create: async (input) => {
        const row: PoolRow = {
          id: crypto.randomUUID(),
          name: input.name,
          policy: input.policy ?? "sticky",
          overflowAccountId: input.overflowAccountId ?? null,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        }
        pools.push(row)
        return row
      },
      list: async () => [...pools],
      findById: async (id) => pools.find((row) => row.id === id),
      findByName: async (name) => pools.find((row) => row.name === name),
      findByIds: async (ids) => pools.filter((row) => ids.includes(row.id)),
      update: async (id, patch, now) => replace(pools, id, patch, now),
      delete: async (id) => remove(pools, id),
      listMembers: async (poolId) => poolMembers.filter((row) => row.poolId === poolId),
      listMembersForPools: async (poolIds) =>
        poolMembers.filter((row) => poolIds.includes(row.poolId)),
      replaceMembers: async (poolId, members) => {
        drop(poolMembers, (row) => row.poolId === poolId)
        const created = members.map((member) => ({
          id: crypto.randomUUID(),
          poolId,
          accountId: member.accountId,
          weight: member.weight ?? 100,
          priority: member.priority ?? 0,
          createdAt: EPOCH,
        }))
        poolMembers.push(...created)
        return created
      },
    },

    // Same three rules the real repository enforces in SQL: `consume` is atomic and one-shot, an
    // expired row is as good as absent, and abandoning stamps every live row for one account.
    oauthStates: {
      create: async (input) => {
        const row: OauthStateRow = {
          id: crypto.randomUUID(),
          state: input.state,
          codeVerifier: input.codeVerifier,
          nonce: input.nonce ?? null,
          provider: input.provider,
          accountId: input.accountId ?? null,
          redirectUri: input.redirectUri ?? null,
          consumedAt: null,
          expiresAt: input.expiresAt,
          createdAt: EPOCH,
        }
        oauthStates.push(row)
        return row
      },
      consume: async (state, now) => {
        const row = oauthStates.find(
          (candidate) =>
            candidate.state === state && candidate.consumedAt === null && candidate.expiresAt > now,
        )
        if (row === undefined) return undefined
        row.consumedAt = now
        return { ...row }
      },
      abandonForAccount: async (accountId, now) => {
        const live = oauthStates.filter(
          (row) => row.accountId === accountId && row.consumedAt === null && row.expiresAt > now,
        )
        for (const row of live) row.consumedAt = now
        return live.length
      },
      deleteExpiredBefore: async (cutoff, limit) => {
        const expired = oauthStates.filter((row) => row.expiresAt < cutoff).slice(0, limit)
        drop(oauthStates, (row) => expired.includes(row))
        return expired.length
      },
    },

    audit: {
      append: async (input) => {
        const row: AuditEventRow = {
          id: crypto.randomUUID(),
          kind: input.kind,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          detail: input.detail ?? null,
          createdAt: EPOCH,
        }
        audit.push(row)
        return row
      },
    },
  }
}

function replace<T extends { id: string; updatedAt: Date }>(
  rows: T[],
  id: string,
  patch: Record<string, unknown>,
  now: Date,
): T | undefined {
  const index = rows.findIndex((row) => row.id === id)
  if (index === -1) return undefined
  const current = rows[index]
  if (current === undefined) return undefined
  const next = { ...current, ...defined(patch), updatedAt: now } as T
  rows[index] = next
  return next
}

/** Mirrors the repositories: an absent key changes nothing, `null` clears. */
function defined(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

function remove<T extends { id: string }>(rows: T[], id: string): boolean {
  const index = rows.findIndex((row) => row.id === id)
  if (index === -1) return false
  rows.splice(index, 1)
  return true
}

function drop<T>(rows: T[], match: (row: T) => boolean): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row !== undefined && match(row)) rows.splice(index, 1)
  }
}
