import type { AdminMutationRepository, ApiKeyRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, createAuditRecorder } from "../admin/audit"

/**
 * Deletes a pool that has had no member for the configured window, and decides what that does to
 * every key whose scope names it.
 *
 * A memberless pool serves nothing: every key scoped to it answers the empty-candidate refusal, and
 * the pool sits in the console as if it were capacity. After `RETENTION_EMPTY_POOL_DAYS` of that it
 * is deleted. The admin plane's own delete refuses a pool any key still names ("re-scope them
 * first"); the reaper is the one deletion that cannot ask a human, so it settles the keys itself:
 *
 * - **A key scoped to pools whose every pool is gone is revoked.** Its scope would otherwise be an
 *   empty pool list, which reaches nothing and reads as a working credential. Revocation is the
 *   honest state, and it is retrievable and audited like an operator's.
 * - **A key with another target just loses the pool**, through the `api_key_pools` cascade. It
 *   still reaches what it reached a moment ago, since the pool contributed no account.
 *
 * Everything happens in one transaction under the pool's row lock, re-checked there: a member
 * added after the candidate list was read, or a key edit in flight, wins over the reap.
 */

export interface PoolReapResult {
  readonly kind: "reaped"
  readonly poolId: string
  readonly poolName: string
  readonly emptySince: Date
  /** Keys revoked because this pool was the last target their scope named. */
  readonly revokedKeyIds: readonly string[]
  /** Live keys that keep another target and lost only this pool. */
  readonly detachedKeyIds: readonly string[]
}

/** Why a candidate was left alone. Each one is a state a later tick re-reads, never an error. */
export interface PoolReapSkip {
  readonly kind: "skipped"
  readonly poolId: string
  readonly reason: "gone" | "has_members" | "not_due"
}

export type PoolReapOutcome = PoolReapResult | PoolReapSkip

export interface KeyFates {
  readonly revoke: readonly string[]
  readonly detach: readonly string[]
}

/**
 * Pure: each live key naming the pool, revoked when nothing else in its scope survives, detached
 * otherwise. `otherPoolIds` is every pool the key names besides the one being reaped. An already
 * revoked key is neither: the cascade removes its binding and nothing about it changes.
 */
export function planKeyFates(
  keys: readonly Pick<ApiKeyRow, "id" | "scope" | "revoked">[],
  otherPoolIds: ReadonlyMap<string, readonly string[]>,
): KeyFates {
  const revoke: string[] = []
  const detach: string[] = []
  for (const key of keys) {
    if (key.revoked) continue
    const survives = key.scope !== "pools" || (otherPoolIds.get(key.id) ?? []).length > 0
    if (survives) detach.push(key.id)
    else revoke.push(key.id)
  }
  return { revoke, detach }
}

export interface PoolReaperDeps {
  readonly mutations: AdminMutationRepository
  readonly now: () => Date
  /** After commit: the routing catalog drops the pool. */
  readonly onPoolDeleted: (poolId: string) => Promise<void>
  /** After commit, per revoked key: the verification cache forgets it at once. */
  readonly onKeyRevoked: (keyId: string) => void
  /** After commit, per detached key: its cached scope is re-read. */
  readonly onKeyDetached: (keyId: string) => void
}

export interface PoolReaper {
  /** Deletes `poolId` if it is still memberless and has been since at or before `cutoff`. */
  reap(poolId: string, cutoff: Date): Promise<PoolReapOutcome>
}

export function createPoolReaper(deps: PoolReaperDeps): PoolReaper {
  return {
    reap: async (poolId, cutoff) => {
      const outcome = await deps.mutations.run({ kind: "pool", id: poolId }, async (tx) => {
        const pool = await tx.pools.findById(poolId)
        if (pool === undefined) return skip(poolId, "gone")
        if ((await tx.pools.listMembers(poolId)).length > 0) return skip(poolId, "has_members")
        const emptySince = pool.emptySince
        if (emptySince === null || emptySince.getTime() > cutoff.getTime()) {
          return skip(poolId, "not_due")
        }

        const keys = await tx.keys.lockKeysScopedToPool(poolId)
        const otherPoolIds = new Map<string, readonly string[]>()
        for (const key of keys) {
          const targets = await tx.keys.listPoolTargets(key.id)
          otherPoolIds.set(
            key.id,
            targets.filter((target) => target.poolId !== poolId).map((target) => target.poolId),
          )
        }
        const fates = planKeyFates(keys, otherPoolIds)

        const now = deps.now()
        const audit = createAuditRecorder(tx.audit)
        const names = new Map(keys.map((key) => [key.id, key.name]))
        for (const keyId of fates.revoke) {
          await tx.keys.markRevoked(keyId, now)
          await audit.record({
            kind: AUDIT_KINDS.keyRevoked,
            subjectType: AUDIT_SUBJECTS.key,
            subjectId: keyId,
            detail: { name: names.get(keyId), reason: "pool_reaped", poolId },
          })
        }
        if (!(await tx.pools.delete(poolId))) return skip(poolId, "gone")
        await audit.record({
          kind: AUDIT_KINDS.poolDeleted,
          subjectType: AUDIT_SUBJECTS.pool,
          subjectId: poolId,
          detail: {
            name: pool.name,
            policy: pool.policy,
            reason: "empty_pool_reaped",
            emptySince: emptySince.toISOString(),
            revokedKeyIds: fates.revoke,
            detachedKeyIds: fates.detach,
          },
        })
        const reaped: PoolReapResult = {
          kind: "reaped",
          poolId,
          poolName: pool.name,
          emptySince,
          revokedKeyIds: fates.revoke,
          detachedKeyIds: fates.detach,
        }
        return reaped
      })

      if (outcome.kind === "reaped") {
        for (const keyId of outcome.revokedKeyIds) deps.onKeyRevoked(keyId)
        for (const keyId of outcome.detachedKeyIds) deps.onKeyDetached(keyId)
        await deps.onPoolDeleted(poolId)
      }
      return outcome
    },
  }
}

function skip(poolId: string, reason: PoolReapSkip["reason"]): PoolReapSkip {
  return { kind: "skipped", poolId, reason }
}
