import type { RoutingPolicy } from "@multi-ai-router/core"
import { asc, eq, inArray } from "drizzle-orm"
import type { Database } from "../client"
import { type PoolMemberRow, type PoolRow, poolMembers, pools } from "../schema/pools"

/**
 * Repositories own SQL. Services call these methods and never write a query
 * inline — this file is the only place that knows `pools` and `pool_members`
 * are tables.
 *
 * Membership carries its own `weight` and `priority`: those are properties of
 * *that* membership, not of the account globally, which is why the routing
 * snapshot reads them from here and only falls back to the account's own values
 * (docs/idea/02-domain-model.md#pool).
 *
 * `overflowAccountId` is the pool's member of last resort. It is stored on the
 * pool rather than as a flagged membership row because it is deliberately
 * invisible to the routing policy until every ordinary member has filtered out.
 */
export interface PoolRepository {
  create(input: CreatePoolInput): Promise<PoolRow>
  /** Oldest first, so the admin list is stable across calls. */
  list(): Promise<PoolRow[]>
  findById(id: string): Promise<PoolRow | undefined>
  /** Name is unique per deployment; the service checks it before insert. */
  findByName(name: string): Promise<PoolRow | undefined>
  findByIds(ids: readonly string[]): Promise<PoolRow[]>
  /** `undefined` when no pool has that id. Absent fields are left untouched. */
  update(id: string, patch: UpdatePoolInput, now: Date): Promise<PoolRow | undefined>
  /** `true` when a row was removed. Membership and key bindings cascade. */
  delete(id: string): Promise<boolean>

  listMembers(poolId: string): Promise<PoolMemberRow[]>
  /** Membership for several pools in one query — the admin list view. */
  listMembersForPools(poolIds: readonly string[]): Promise<PoolMemberRow[]>
  /** Pools an account belongs to. Used before a destructive account change. */
  listMembershipsForAccount(accountId: string): Promise<PoolMemberRow[]>
  /**
   * Membership is edited as a whole set, never row by row: the console sends the
   * intended member list and the two statements run in one transaction, so a
   * pool is never briefly empty or half-updated.
   */
  replaceMembers(poolId: string, members: readonly PoolMemberInput[]): Promise<PoolMemberRow[]>
}

export interface CreatePoolInput {
  readonly name: string
  readonly policy?: RoutingPolicy
  readonly overflowAccountId?: string | null
}

export interface UpdatePoolInput {
  readonly name?: string
  readonly policy?: RoutingPolicy
  /** `null` clears the overflow account; `undefined` leaves it as it is. */
  readonly overflowAccountId?: string | null
}

export interface PoolMemberInput {
  readonly accountId: string
  readonly weight?: number
  readonly priority?: number
}

export function createPoolRepository(db: Database): PoolRepository {
  return {
    create: async (input) => {
      const rows = await db
        .insert(pools)
        .values({
          name: input.name,
          ...(input.policy === undefined ? {} : { policy: input.policy }),
          overflowAccountId: input.overflowAccountId ?? null,
        })
        .returning()
      return required(rows[0], "create")
    },

    list: () => db.select().from(pools).orderBy(asc(pools.createdAt)),

    findById: async (id) => {
      const rows = await db.select().from(pools).where(eq(pools.id, id)).limit(1)
      return rows[0]
    },

    findByName: async (name) => {
      const rows = await db.select().from(pools).where(eq(pools.name, name)).limit(1)
      return rows[0]
    },

    findByIds: async (ids) => {
      if (ids.length === 0) return []
      return db
        .select()
        .from(pools)
        .where(inArray(pools.id, [...ids]))
    },

    update: async (id, patch, now) => {
      const rows = await db
        .update(pools)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.policy === undefined ? {} : { policy: patch.policy }),
          ...(patch.overflowAccountId === undefined
            ? {}
            : { overflowAccountId: patch.overflowAccountId }),
          updatedAt: now,
        })
        .where(eq(pools.id, id))
        .returning()
      return rows[0]
    },

    delete: async (id) => {
      const rows = await db.delete(pools).where(eq(pools.id, id)).returning({ id: pools.id })
      return rows.length > 0
    },

    listMembers: (poolId) =>
      db
        .select()
        .from(poolMembers)
        .where(eq(poolMembers.poolId, poolId))
        .orderBy(asc(poolMembers.priority), asc(poolMembers.createdAt)),

    listMembersForPools: async (poolIds) => {
      if (poolIds.length === 0) return []
      return db
        .select()
        .from(poolMembers)
        .where(inArray(poolMembers.poolId, [...poolIds]))
        .orderBy(asc(poolMembers.priority), asc(poolMembers.createdAt))
    },

    listMembershipsForAccount: (accountId) =>
      db.select().from(poolMembers).where(eq(poolMembers.accountId, accountId)),

    replaceMembers: (poolId, members) =>
      db.transaction(async (tx) => {
        await tx.delete(poolMembers).where(eq(poolMembers.poolId, poolId))
        if (members.length === 0) return []
        return tx
          .insert(poolMembers)
          .values(
            members.map((member) => ({
              poolId,
              accountId: member.accountId,
              ...(member.weight === undefined ? {} : { weight: member.weight }),
              ...(member.priority === undefined ? {} : { priority: member.priority }),
            })),
          )
          .returning()
      }),
  }
}

/**
 * An `insert ... returning` always yields its row; `undefined` here means the
 * statement did not run as written, which is a bug rather than a request
 * outcome — hence a plain Error, not a `RouterError`.
 */
function required<T>(row: T | undefined, operation: string): T {
  if (row === undefined) {
    throw new Error(`poolRepository.${operation}: statement returned no row`)
  }
  return row
}
