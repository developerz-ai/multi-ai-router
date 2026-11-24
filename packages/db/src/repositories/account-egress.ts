import { and, asc, eq, isNotNull, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
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
}

export interface AccountEgressMethods {
  /** Every account with an egress proxy, oldest first. Ciphertext of the credential is not read. */
  listWithEgressProxy(): Promise<EgressAccountRow[]>
  /**
   * Compare-and-swap of `egress_proxy`: written only while the stored `sealed` is still
   * `expectedSealed`, so an operator's edit made meanwhile wins. `undefined` when it did not apply
   * (edited, cleared, deleted, set back to `manual` under a sweep, or `exclusive` and the target
   * is taken).
   */
  swapEgressProxy(input: SwapEgressProxyInput): Promise<AccountRow | undefined>
}

export function createAccountEgressMethods(db: DatabaseExecutor): AccountEgressMethods {
  return {
    listWithEgressProxy: async () => {
      const rows = await db
        .select({
          id: accounts.id,
          label: accounts.label,
          provider: accounts.provider,
          baseUrl: accounts.baseUrl,
          dialect: accounts.dialect,
          status: accounts.status,
          egressProxy: accounts.egressProxy,
        })
        .from(accounts)
        .where(isNotNull(accounts.egressProxy))
        .orderBy(asc(accounts.createdAt), asc(accounts.id))
      return rows.flatMap((row) =>
        row.egressProxy === null ? [] : [{ ...row, egressProxy: row.egressProxy }],
      )
    },

    // One statement, so the check and the write see one snapshot. Sweeps are single-flighted by the
    // task's advisory lock; an operator's own assign is a plain update and is allowed to share.
    swapEgressProxy: async ({ id, expectedSealed, next, exclusive, actor, now, recorded }) => {
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
