import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountEgressHealth } from "../schema/account-egress-health"
import { type AccountRow, accounts, type StoredEgressProxy } from "../schema/accounts"
import { createAccountEgressHealthRepository } from "./account-egress-health-repository"

/** What the proxy sweep reads of an account: no credential column, and the proxy is present. */
export type EgressAccountRow = Pick<
  AccountRow,
  "id" | "label" | "provider" | "baseUrl" | "dialect" | "status"
> & { readonly egressProxy: StoredEgressProxy }

export interface SwapEgressProxyInput {
  readonly id: string
  /** The `sealed` value the caller decided against. A different one now means someone edited it. */
  readonly expectedSealed: string
  readonly next: StoredEgressProxy
  /**
   * True for a swap onto another proxy: refused when any other account already holds `next`'s
   * address or its vendor identity. False for a change that keeps the identity (re-seal in place,
   * replace-mode change).
   */
  readonly exclusive: boolean
  /**
   * Who is writing. `sweep` applies only while the stored proxy still says `replace: on-failure`:
   * an operator who set it back to `manual` mid-sweep must win. `operator` is the operator's own
   * mode change and has no such condition.
   */
  readonly actor: "sweep" | "operator"
  readonly now: Date
  /**
   * Records the health row in the same transaction as the swap, so a swap can never commit
   * without its cooldown stamp. Written only when the swap applied; if it fails, the swap rolls
   * back with it. `swappedAt` is set for a swap and absent for a re-seal in place.
   */
  readonly recorded?: { readonly assignment: string; readonly swappedAt?: Date }
  /**
   * The upstream endpoint the caller probed `next` against. Given, the swap applies only while the
   * account still has exactly that `base_url` and `dialect`: a candidate never tested against the
   * endpoint the account now serves is not installed. A sweep always states it.
   */
  readonly expectedUpstream?: Pick<AccountRow, "baseUrl" | "dialect">
}

export interface AccountEgressMethods {
  /** Every account with an egress proxy, oldest first. Ciphertext of the credential is not read. */
  listWithEgressProxy(): Promise<EgressAccountRow[]>
  /**
   * Compare-and-swap of `egress_proxy`: written only while the stored `sealed` is still
   * `expectedSealed`, so an operator's edit made meanwhile wins. `undefined` when it did not apply
   * (edited, cleared, deleted, set back to `manual` under a sweep, moved to another endpoint than
   * the one in `expectedUpstream`, or `exclusive` and the target is taken).
   */
  swapEgressProxy(input: SwapEgressProxyInput): Promise<AccountRow | undefined>
  /**
   * The accounts a sweep should look at next: proxied, not disabled, least recently attempted
   * first (never-attempted before all), at most `limit`. The order is the health row's
   * `updated_at`, which every check, repair and attempt write advances, so an account whose check
   * cannot run still takes its turn at the back instead of heading every batch.
   */
  listDueEgressChecks(input: { readonly limit: number }): Promise<EgressAccountRow[]>
  /** The proxy identities every other account holds, disabled ones included. Advisory only. */
  listHeldEgressProxies(exceptId: string): Promise<HeldEgressProxy[]>
  /**
   * The operator's assign or clear, in one statement. With `inheritReplace`, `next` keeps the
   * `replace` mode stored on the row being written, so a mode changed after the caller's read is
   * not overwritten. Touches `egress_proxy` and `updated_at` only: no lifecycle or recovery version.
   */
  assignEgressProxy(input: {
    readonly id: string
    readonly next: StoredEgressProxy | null
    readonly inheritReplace: boolean
    readonly now: Date
  }): Promise<AccountRow | undefined>
}

export interface HeldEgressProxy {
  readonly address: string
  readonly vendor: string | null
  readonly vendorId: string | null
}

const egressColumns = {
  id: accounts.id,
  label: accounts.label,
  provider: accounts.provider,
  baseUrl: accounts.baseUrl,
  dialect: accounts.dialect,
  status: accounts.status,
  egressProxy: accounts.egressProxy,
}
type EgressSelected = Omit<EgressAccountRow, "egressProxy"> & {
  readonly egressProxy: StoredEgressProxy | null
}
/** The query already asks for a non-null proxy; this only tells the type so. */
const present = (row: EgressSelected): EgressAccountRow[] =>
  row.egressProxy === null ? [] : [{ ...row, egressProxy: row.egressProxy }]

export function createAccountEgressMethods(db: DatabaseExecutor): AccountEgressMethods {
  return {
    listWithEgressProxy: async () => {
      const rows = await db
        .select(egressColumns)
        .from(accounts)
        .where(isNotNull(accounts.egressProxy))
        .orderBy(asc(accounts.createdAt), asc(accounts.id))
      return rows.flatMap(present)
    },

    listDueEgressChecks: async ({ limit }) => {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("egress check batch outside bounds")
      const rows = await db
        .select(egressColumns)
        .from(accounts)
        .leftJoin(accountEgressHealth, eq(accountEgressHealth.accountId, accounts.id))
        .where(and(isNotNull(accounts.egressProxy), ne(accounts.status, "disabled")))
        .orderBy(
          sql`${accountEgressHealth.updatedAt} asc nulls first`,
          asc(accounts.createdAt),
          asc(accounts.id),
        )
        .limit(limit)
      return rows.flatMap(present)
    },

    listHeldEgressProxies: async (exceptId) => {
      const rows = await db
        .select({
          address: sql<string | null>`${accounts.egressProxy}->>'address'`,
          vendor: sql<string | null>`${accounts.egressProxy}->>'vendor'`,
          vendorId: sql<string | null>`${accounts.egressProxy}->>'vendorId'`,
        })
        .from(accounts)
        .where(and(isNotNull(accounts.egressProxy), ne(accounts.id, exceptId)))
      return rows.flatMap((row) => (row.address === null ? [] : [{ ...row, address: row.address }]))
    },

    assignEgressProxy: async ({ id, next, inheritReplace, now }) => {
      const value = sql`${next === null ? null : JSON.stringify(next)}::jsonb`
      const rows = await db
        .update(accounts)
        .set({
          egressProxy:
            next === null || !inheritReplace
              ? next
              : sql`case when ${accounts.egressProxy} ? 'replace'
                  then ${value} || jsonb_build_object('replace', ${accounts.egressProxy}->'replace')
                  else ${value} end`,
          updatedAt: now,
        })
        .where(eq(accounts.id, id))
        .returning()
      return rows[0]
    },

    // One statement, so the check and the write see one snapshot. Sweeps are single-flighted by the
    // task's advisory lock; an operator's own assign is a plain update and is allowed to share.
    swapEgressProxy: async (input) => {
      const { id, expectedSealed, next, exclusive, actor, now, recorded } = input
      const observed = input.expectedUpstream
      const taken = sql`exists (
        select 1 from accounts o where o.id <> ${id}::uuid and (
          o.egress_proxy->>'address' = ${next.address}::text
          ${
            next.vendor === undefined || next.vendorId === undefined
              ? sql``
              : sql`or (o.egress_proxy->>'vendor' = ${next.vendor}::text and o.egress_proxy->>'vendorId' = ${next.vendorId}::text)`
          }))`
      const write = async (executor: DatabaseExecutor) => {
        const rows = await executor
          .update(accounts)
          .set({ egressProxy: next, updatedAt: now })
          .where(
            and(
              eq(accounts.id, id),
              sql`${accounts.egressProxy}->>'sealed' = ${expectedSealed}::text`,
              actor === "sweep"
                ? sql`${accounts.egressProxy}->>'replace' = 'on-failure'`
                : undefined,
              observed === undefined
                ? undefined
                : sql`${accounts.baseUrl} is not distinct from ${observed.baseUrl}::text and ${accounts.dialect} is not distinct from ${observed.dialect}::text`,
              exclusive ? sql`not ${taken}` : undefined,
            ),
          )
          .returning()
        return rows[0]
      }
      if (recorded === undefined) return write(db)
      return db.transaction(async (tx) => {
        const account = await write(tx)
        if (account !== undefined)
          await createAccountEgressHealthRepository(tx).recordRepair({
            accountId: id,
            assignment: recorded.assignment,
            repair: "idle",
            ...(recorded.swappedAt === undefined ? {} : { swappedAt: recorded.swappedAt }),
          })
        return account
      })
    },
  }
}
