import type {
  AccountRepository,
  AccountRow,
  ApiKeyRepository,
  PoolRepository,
  PoolRow,
} from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, conflict, invalid, notFound, ok } from "../admin/result"
import type { CreatePoolBody, PoolMemberInputBody, UpdatePoolBody } from "./schemas"
import { type PoolView, toPoolView } from "./view"

/**
 * Pool CRUD for the admin plane.
 *
 * The rule this service exists to enforce is that **a pool never references an
 * account that does not exist**. Membership and the overflow account are both
 * checked at write time, because the alternative is a routing snapshot with
 * unresolvable ids in it: selection would quietly skip them and the operator
 * would debug an empty candidate set instead of reading an error at the moment
 * they made the mistake.
 */

export interface PoolsService {
  list(): Promise<AdminResult<readonly PoolView[]>>
  get(id: string): Promise<AdminResult<PoolView>>
  create(body: CreatePoolBody): Promise<AdminResult<PoolView>>
  update(id: string, body: UpdatePoolBody): Promise<AdminResult<PoolView>>
  remove(id: string): Promise<AdminResult<{ readonly id: string; readonly deleted: true }>>
}

export interface PoolsServiceDeps {
  readonly pools: PoolRepository
  readonly accounts: Pick<AccountRepository, "list">
  /** Read-only: deleting a pool must say which keys it would silently narrow. */
  readonly keys: Pick<ApiKeyRepository, "listKeysScopedToPool">
  readonly audit: AuditRecorder
  readonly now: () => Date
}

export function createPoolsService(deps: PoolsServiceDeps): PoolsService {
  /**
   * One read of every account, reused for member validation and for rendering.
   * The admin plane is not the hot path, and a per-member lookup here would be
   * N queries to answer one screen.
   */
  const accountIndex = async (): Promise<ReadonlyMap<string, AccountRow>> =>
    new Map((await deps.accounts.list()).map((account) => [account.id, account]))

  const render = async (pool: PoolRow): Promise<PoolView> =>
    toPoolView(pool, await deps.pools.listMembers(pool.id), await accountIndex())

  const applyMembers = async (
    poolId: string,
    members: readonly PoolMemberInputBody[] | undefined,
  ): Promise<void> => {
    if (members === undefined) return
    await deps.pools.replaceMembers(poolId, members)
  }

  return {
    list: async () => {
      const pools = await deps.pools.list()
      const [members, accounts] = await Promise.all([
        deps.pools.listMembersForPools(pools.map((pool) => pool.id)),
        accountIndex(),
      ])
      return ok(pools.map((pool) => toPoolView(pool, members, accounts)))
    },

    get: async (id) => {
      const pool = await deps.pools.findById(id)
      return pool === undefined ? notFound(`no pool with id "${id}"`) : ok(await render(pool))
    },

    create: async (body) => {
      const accounts = await accountIndex()
      const checked = checkReferences(body.members, body.overflowAccountId ?? null, accounts)
      if (!checked.ok) return checked

      const taken = await deps.pools.findByName(body.name)
      if (taken !== undefined) return conflict(`a pool named "${body.name}" already exists`)

      const pool = await deps.pools.create({
        name: body.name,
        ...(body.policy === undefined ? {} : { policy: body.policy }),
        overflowAccountId: body.overflowAccountId ?? null,
      })
      await applyMembers(pool.id, body.members)

      await deps.audit.record({
        kind: AUDIT_KINDS.poolCreated,
        subjectType: AUDIT_SUBJECTS.pool,
        subjectId: pool.id,
        detail: {
          name: pool.name,
          policy: pool.policy,
          memberCount: body.members?.length ?? 0,
          hasOverflow: pool.overflowAccountId !== null,
        },
      })

      return ok(await render(pool))
    },

    update: async (id, body) => {
      const current = await deps.pools.findById(id)
      if (current === undefined) return notFound(`no pool with id "${id}"`)

      const accounts = await accountIndex()
      const overflow = body.overflowAccountId === undefined ? null : body.overflowAccountId
      const checked = checkReferences(body.members, overflow, accounts)
      if (!checked.ok) return checked

      if (body.name !== undefined && body.name !== current.name) {
        const taken = await deps.pools.findByName(body.name)
        if (taken !== undefined) return conflict(`a pool named "${body.name}" already exists`)
      }

      const pool = await deps.pools.update(
        id,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.policy === undefined ? {} : { policy: body.policy }),
          ...(body.overflowAccountId === undefined
            ? {}
            : { overflowAccountId: body.overflowAccountId }),
        },
        deps.now(),
      )
      if (pool === undefined) return notFound(`no pool with id "${id}"`)
      await applyMembers(id, body.members)

      await deps.audit.record({
        kind: AUDIT_KINDS.poolUpdated,
        subjectType: AUDIT_SUBJECTS.pool,
        subjectId: pool.id,
        detail: {
          name: pool.name,
          fields: Object.keys(body).sort(),
          // The policy change is the one every "why did routing change" question starts at.
          policyBefore: current.policy,
          policyAfter: pool.policy,
          ...(body.members === undefined ? {} : { memberCount: body.members.length }),
        },
      })

      return ok(await render(pool))
    },

    remove: async (id) => {
      const pool = await deps.pools.findById(id)
      if (pool === undefined) return notFound(`no pool with id "${id}"`)

      // Deleting the pool cascades its `api_key_pools` rows, so a key scoped to
      // it would silently lose candidates — and a key left scoped to nothing
      // fails every request. Name the keys instead of doing it quietly.
      const scoped = await deps.keys.listKeysScopedToPool(id)
      if (scoped.length > 0) {
        return conflict(
          `pool "${pool.name}" is named by the scope of ${scoped.length} key(s): ${scoped
            .map((key) => `"${key.name}"`)
            .join(", ")}. Re-scope them first.`,
          "pool_in_use",
        )
      }

      const deleted = await deps.pools.delete(id)
      if (!deleted) return notFound(`no pool with id "${id}"`)

      await deps.audit.record({
        kind: AUDIT_KINDS.poolDeleted,
        subjectType: AUDIT_SUBJECTS.pool,
        subjectId: id,
        detail: { name: pool.name, policy: pool.policy },
      })

      return ok({ id, deleted: true })
    },
  }
}

/** Membership and overflow must both name real accounts, and a member may appear once. */
function checkReferences(
  members: readonly PoolMemberInputBody[] | undefined,
  overflowAccountId: string | null,
  accounts: ReadonlyMap<string, AccountRow>,
): AdminResult<null> {
  if (members !== undefined) {
    const seen = new Set<string>()
    const unknown: string[] = []
    for (const member of members) {
      if (seen.has(member.accountId)) {
        return invalid(
          `account "${member.accountId}" is listed twice: a pool holds one membership per account`,
          "duplicate_member",
        )
      }
      seen.add(member.accountId)
      if (!accounts.has(member.accountId)) unknown.push(member.accountId)
    }
    if (unknown.length > 0) {
      return invalid(
        `no account with id ${unknown.map((id) => `"${id}"`).join(", ")}`,
        "unknown_account",
      )
    }
  }

  if (overflowAccountId !== null && !accounts.has(overflowAccountId)) {
    return invalid(
      `overflow account "${overflowAccountId}" does not exist`,
      "unknown_overflow_account",
    )
  }

  return ok(null)
}
