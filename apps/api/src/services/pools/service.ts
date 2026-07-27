import { DEFAULT_ACCOUNT_PRIORITY, DEFAULT_ACCOUNT_WEIGHT } from "@multi-ai-router/core"
import type {
  AccountRepository,
  AccountRow,
  ApiKeyRepository,
  PoolMemberInput,
  PoolMemberRow,
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
 *
 * The overflow carries a second rule: **it must be one of the pool's members**.
 * Candidates are `pool_members ∩ key_scope` and nothing widens that
 * (CLAUDE.md non-negotiable 6), so an overflow outside the membership would let
 * a key scoped to this pool spend an account it never named. Designating one is
 * therefore a property of a membership — the pool holds that member back from
 * the policy — and both writes check it against the pool *as it will be after
 * the write*, which is why an edit that drops the overflow's membership is
 * refused rather than silently leaving a reference routing never honors.
 *
 * The third rule is about what a write does *not* say. Membership is replaced as
 * a whole set, so every write restates every member — and `weight`/`priority`
 * are optional on each one. Letting an absent field fall through to the column
 * default would mean a body naming only `accountId` silently re-flattens a
 * `weighted` pool and re-orders a `priority-failover` one; renaming a pool would
 * change where its traffic goes. So an absent field is *resolved*, never
 * defaulted: to what the membership already carries, and to the account's own
 * value when there is no membership yet. Sending a number is the only way to
 * change one.
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
    accounts: ReadonlyMap<string, AccountRow>,
    held: readonly PoolMemberRow[],
  ): Promise<void> => {
    if (members === undefined) return
    await deps.pools.replaceMembers(poolId, members.map(resolveTuning(accounts, held)))
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
      const checked = checkReferences({
        members: body.members,
        memberIds: idsOf(body.members ?? []),
        overflowAccountId: body.overflowAccountId ?? null,
        accounts,
      })
      if (!checked.ok) return checked

      const taken = await deps.pools.findByName(body.name)
      if (taken !== undefined) return conflict(`a pool named "${body.name}" already exists`)

      const pool = await deps.pools.create({
        name: body.name,
        ...(body.policy === undefined ? {} : { policy: body.policy }),
        overflowAccountId: body.overflowAccountId ?? null,
      })
      // A pool that did not exist a statement ago holds no membership, so every absent
      // weight/priority here resolves to the account's own.
      await applyMembers(pool.id, body.members, accounts, [])

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

      // The membership the pool holds right now, read whether or not the patch names one: it
      // decides both what the overflow is checked against and what an omitted weight/priority
      // resolves to.
      const held = await deps.pools.listMembers(id)
      const accounts = await accountIndex()
      // The pool as it will be *after* this patch: an absent `members` leaves the set alone and an
      // absent `overflowAccountId` leaves the current one, so "this edit drops the overflow's
      // membership" is only visible against the stored row, never against the body.
      const checked = checkReferences({
        members: body.members,
        memberIds: body.members === undefined ? idsOf(held) : idsOf(body.members),
        overflowAccountId:
          body.overflowAccountId === undefined ? current.overflowAccountId : body.overflowAccountId,
        accounts,
      })
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
      await applyMembers(id, body.members, accounts, held)

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

      // A second, narrower event for the same edit, because the two answer different questions:
      // `pool.updated` is what the operator did, `policy.changed` is where every future request
      // will go. Compared against the row that came back rather than against the body, so a
      // PATCH naming the policy a pool already has writes nothing at all.
      if (pool.policy !== current.policy) {
        await deps.audit.record({
          kind: AUDIT_KINDS.policyChanged,
          subjectType: AUDIT_SUBJECTS.pool,
          subjectId: pool.id,
          detail: { poolId: pool.id, from: current.policy, to: pool.policy },
        })
      }

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

interface ReferenceCheck {
  /** The membership the write carries, or `undefined` when it leaves the set alone. */
  readonly members: readonly PoolMemberInputBody[] | undefined
  /** The membership the pool will hold once the write lands. */
  readonly memberIds: ReadonlySet<string>
  /** The overflow the pool will hold once the write lands. */
  readonly overflowAccountId: string | null
  readonly accounts: ReadonlyMap<string, AccountRow>
}

/**
 * Membership and overflow must both name real accounts, a member may appear
 * once, and the overflow must be one of the members.
 */
function checkReferences(check: ReferenceCheck): AdminResult<null> {
  const { members, memberIds, overflowAccountId, accounts } = check

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

  if (overflowAccountId === null) return ok(null)

  if (!accounts.has(overflowAccountId)) {
    return invalid(
      `overflow account "${overflowAccountId}" does not exist`,
      "unknown_overflow_account",
    )
  }

  if (!memberIds.has(overflowAccountId)) {
    return invalid(
      `overflow account "${overflowAccountId}" is not a member of this pool. The overflow is a ` +
        `member held back from the policy, not a way out of the pool: a key scoped to this pool ` +
        `must never reach an account the pool does not hold. Add it as a member, or clear the ` +
        `overflow.`,
      "overflow_not_member",
    )
  }

  return ok(null)
}

function idsOf(members: readonly { readonly accountId: string }[]): ReadonlySet<string> {
  return new Set(members.map((member) => member.accountId))
}

/**
 * Fills in what the write left unsaid, so `replaceMembers` is handed a fully
 * stated membership and the column defaults never decide routing.
 *
 * Precedence is: the number the body sent → the number this membership already
 * carries → the account's own. The middle step is the one that keeps a rename
 * from re-flattening a `weighted` pool, and the last is what makes "absent
 * inherits the account's own" (`schemas.ts`) true for a member being added.
 */
function resolveTuning(
  accounts: ReadonlyMap<string, AccountRow>,
  held: readonly PoolMemberRow[],
): (member: PoolMemberInputBody) => PoolMemberInput {
  const current = new Map(held.map((member) => [member.accountId, member]))
  return (member) => {
    const membership = current.get(member.accountId)
    const account = accounts.get(member.accountId)
    return {
      accountId: member.accountId,
      weight: member.weight ?? membership?.weight ?? account?.weight ?? DEFAULT_ACCOUNT_WEIGHT,
      priority:
        member.priority ?? membership?.priority ?? account?.priority ?? DEFAULT_ACCOUNT_PRIORITY,
    }
  }
}
