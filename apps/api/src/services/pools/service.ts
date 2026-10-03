import type {
  AccountRepository,
  AccountRow,
  AdminMutationRepository,
  PoolRepository,
  PoolRow,
} from "@multi-ai-router/db"
import { type AdminResult, notFound, ok } from "../admin/result"
import { createPoolMutations, type PoolMutationKind } from "./mutations"
import type { CreatePoolBody, UpdatePoolBody } from "./schemas"
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
  readonly pools: Pick<PoolRepository, "list" | "findById" | "listMembers" | "listMembersForPools">
  readonly accounts: Pick<AccountRepository, "list">
  readonly mutations: AdminMutationRepository
  /** Runs immediately after commit, before rendering a response. */
  readonly onCommitted: (id: string, kind: PoolMutationKind) => void | Promise<void>
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

    ...createPoolMutations(deps),
  }
}
