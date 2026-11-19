import type {
  AccountRow,
  AdminMutationRepository,
  ApiKeyAccountRow,
  ApiKeyPoolRow,
  ApiKeyRow,
  AuditEventRow,
  OauthStateRow,
  PoolMemberRow,
  PoolRow,
  RecoveryRow,
} from "@multi-ai-router/db"
import { memoryAccountLifecycle } from "./memory-account-lifecycle"
import { memoryAccountQuota } from "./memory-account-quota"
import { memoryKeys } from "./memory-keys"
import { createMemoryMutations } from "./memory-mutations"
import { drop, remove, replace } from "./memory-row-operations"
import type { MemoryStore } from "./memory-store-types"

export type { MemoryAccounts, MemoryKeys, MemoryStore } from "./memory-store-types"

/**
 * In-memory stands-in for the stores the admin services depend on.
 *
 * These are not mocks with expectations — they are the smallest honest
 * implementation of the same interfaces, so a service under test exercises its
 * real code path and the test asserts on rows rather than on calls. No database
 * is involved, which is what lets the admin API's unit *and* integration tests
 * run with no `DATABASE_URL`.
 */

const EPOCH = new Date("2026-07-24T12:00:00.000Z")

export function createMemoryStore(): MemoryStore {
  const accounts: AccountRow[] = []
  const recoveries = new Map<string, Pick<RecoveryRow, "generation" | "state">>()
  const keys: ApiKeyRow[] = []
  const keyPools: ApiKeyPoolRow[] = []
  const keyAccounts: ApiKeyAccountRow[] = []
  const pools: PoolRow[] = []
  const poolMembers: PoolMemberRow[] = []
  const oauthStates: OauthStateRow[] = []
  const audit: AuditEventRow[] = []

  let mutations: AdminMutationRepository | undefined
  const quota = memoryAccountQuota(accounts, recoveries)
  return {
    get mutations() {
      mutations ??= createMemoryMutations(this)
      return mutations
    },
    rows: {
      accounts,
      recoveries,
      keys,
      keyPools,
      keyAccounts,
      pools,
      poolMembers,
      oauthStates,
      audit,
    },

    accounts: {
      ...memoryAccountLifecycle(accounts, oauthStates, recoveries, quota.upsertQuotaWindow),
      ...quota,
      create: async (input) => {
        const row: AccountRow = {
          id: input.id ?? crypto.randomUUID(),
          label: input.label,
          provider: input.provider,
          status: input.status ?? "active",
          lifecycleVersion: 0,
          healthRecoveryVersion: 0,
          authRecoveryVersion: 0,
          authorizationAttemptId: null,
          authMaterial: input.authMaterial ?? null,
          configDir: input.configDir ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          authRefreshSpentOn: null,
          billing: input.billing ?? "metered",
          lastUsedAt: null,
          windowTokenLimits: input.windowTokenLimits ?? null,
          providerPreferences: input.providerPreferences ?? null,
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
      listSummaries: async (filter) =>
        accounts
          .filter(
            (row) =>
              (filter?.status === undefined || row.status === filter.status) &&
              (filter?.provider === undefined || row.provider === filter.provider),
          )
          .map(({ id, label, provider, status, lastUsedAt, createdAt }) => ({
            id,
            label,
            provider,
            status,
            lastUsedAt,
            createdAt,
          })),
      readEligibleBackgroundAccount: async (id, expected) => {
        const row = accounts.find((candidate) => candidate.id === id)
        const state = recoveries.get(id)?.state
        return row !== undefined &&
          row.status === "active" &&
          row.lifecycleVersion === expected.lifecycleVersion &&
          row.authMaterial === expected.authMaterial &&
          row.provider === expected.provider &&
          row.configDir === expected.configDir &&
          state !== "pending" &&
          state !== "issued" &&
          state !== "uncertain"
          ? row
          : undefined
      },
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
      disable: (id, now) =>
        memoryAccountLifecycle(accounts, oauthStates, recoveries).updateOperatorAccount({
          id,
          patch: { status: "disabled" },
          now,
        }),
      // `pool_members.account_id` is `ON DELETE CASCADE`: a deleted account leaves every pool.
      delete: async (id) => {
        const deleted = remove(accounts, id)
        if (deleted) {
          recoveries.delete(id)
          drop(poolMembers, (row) => row.accountId === id)
        }
        return deleted
      },
    },

    keys: memoryKeys(keys, keyPools, keyAccounts, EPOCH),

    pools: {
      create: async (input) => {
        const row: PoolRow = {
          id: crypto.randomUUID(),
          name: input.name,
          policy: input.policy ?? "sticky",
          overflowAccountId: input.overflowAccountId ?? null,
          // The trigger's rule (migration 0047): empty from creation until a member lands.
          emptySince: EPOCH,
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
      // The two `ON DELETE CASCADE`s the schema declares on a pool's id.
      delete: async (id) => {
        drop(poolMembers, (row) => row.poolId === id)
        drop(keyPools, (row) => row.poolId === id)
        return remove(pools, id)
      },
      listEmptySince: async (cutoff, limit) =>
        pools
          .filter(
            (row) =>
              row.emptySince !== null &&
              row.emptySince.getTime() <= cutoff.getTime() &&
              !poolMembers.some((member) => member.poolId === row.id),
          )
          .sort(
            (left, right) => (left.emptySince?.getTime() ?? 0) - (right.emptySince?.getTime() ?? 0),
          )
          .slice(0, limit),
      listMembers: async (poolId) => poolMembers.filter((row) => row.poolId === poolId),
      listMembersForPools: async (poolIds) =>
        poolMembers.filter((row) => poolIds.includes(row.poolId)),
      listMembershipsForAccount: async (accountId) =>
        poolMembers.filter((row) => row.accountId === accountId),
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
        const pool = pools.find((row) => row.id === poolId)
        if (pool !== undefined && created.length > 0) pool.emptySince = null
        else if (pool !== undefined && pool.emptySince === null) pool.emptySince = EPOCH
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
          authorizationLifecycleVersion: input.authorizationLifecycleVersion ?? null,
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
      findLive: async (id, now) => {
        const row = oauthStates.find(
          (candidate) =>
            candidate.id === id && candidate.consumedAt === null && candidate.expiresAt > now,
        )
        return row === undefined ? undefined : { ...row }
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
          actor: input.actor ?? null,
          actorKind: input.actorKind ?? null,
          actorSays: input.actorSays ?? null,
          clientIp: input.clientIp ?? null,
          userAgent: input.userAgent ?? null,
          requestId: input.requestId ?? null,
          createdAt: EPOCH,
        }
        audit.push(row)
        return row
      },
    },
  }
}
