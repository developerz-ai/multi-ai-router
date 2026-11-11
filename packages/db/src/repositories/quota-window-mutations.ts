import type { QuotaWindowState } from "@multi-ai-router/core"
import { and, asc, eq, exists, inArray, lte, ne, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accounts } from "../schema/accounts"
import { quotaWindows } from "../schema/quota-windows"
import type { AccountRepository } from "./account-types"

export interface QuotaWindowWrite {
  readonly accountId: string
  readonly state: QuotaWindowState
}

/**
 * The merge rule for a reading landing on a held window, written once against `excluded` so the
 * single-row and the batched upsert cannot drift. A newer reading replaces the row; a reading at
 * the same instant only raises utilization or pushes the reset later (two replicas observing one
 * response); an older one is refused (`setWhere`), and the held evidence stands.
 */
const incoming = (column: string) => sql.raw(`excluded.${column}`)
const equalTime = sql`${quotaWindows.lastCheckedAt} = ${incoming("last_checked_at")}`
const moreUsed = sql`(${incoming("utilization")} is not null and (${quotaWindows.utilization} is null or ${incoming("utilization")} > ${quotaWindows.utilization}))`
const laterReset = sql`(${incoming("resets_at")} is not null and (${quotaWindows.resetsAt} is null or ${incoming("resets_at")} > ${quotaWindows.resetsAt}))`
const conflict = {
  target: [quotaWindows.accountId, quotaWindows.window],
  set: {
    lastCheckedAt: incoming("last_checked_at"),
    // Marker survives persistence: provider passes it through, the catalog reload reads it back,
    // the overlay hands it to the live routing snapshot. See `services/routing/quota.ts`.
    advisory: incoming("advisory"),
    retiredAt: null,
    evidenceState: "current" as const,
    blocksRouting: true,
    utilization: sql`case when ${equalTime} then greatest(${quotaWindows.utilization}, ${incoming("utilization")}) else ${incoming("utilization")} end`,
    utilizationSource: sql`case when ${equalTime} and not ${moreUsed} then ${quotaWindows.utilizationSource} else ${incoming("utilization_source")} end`,
    resetsAt: sql`case when ${equalTime} then greatest(${quotaWindows.resetsAt}, ${incoming("resets_at")}) else ${incoming("resets_at")} end`,
    resetSource: sql`case when ${equalTime} and not ${laterReset} then ${quotaWindows.resetSource} else ${incoming("reset_source")} end`,
    revision: sql`${quotaWindows.revision} + 1`,
  },
  setWhere: sql`${quotaWindows.lastCheckedAt} < ${incoming("last_checked_at")} or (${equalTime} and ${quotaWindows.retiredAt} is null and (${moreUsed} or ${laterReset}))`,
}

function insertValues({ accountId, state }: QuotaWindowWrite) {
  return {
    accountId,
    window: state.window,
    utilization: state.utilization ?? null,
    utilizationSource: state.utilizationSource,
    resetsAt: state.resetsAt ?? null,
    resetSource: state.resetSource,
    lastCheckedAt: state.lastCheckedAt,
    advisory: state.advisory ?? false,
  }
}

/**
 * Splits a batch into rounds with one reading per `(account, window)` each, in arrival order:
 * `ON CONFLICT DO UPDATE` refuses to touch a row twice in one statement, and applying the
 * readings in order is what the per-row rule above expects.
 */
function rounds(writes: readonly QuotaWindowWrite[]): QuotaWindowWrite[][] {
  const out: QuotaWindowWrite[][] = []
  const seen: Set<string>[] = []
  for (const write of writes) {
    const key = `${write.accountId}\u0000${write.state.window}`
    let index = seen.findIndex((keys) => !keys.has(key))
    if (index === -1) {
      index = out.length
      out.push([])
      seen.push(new Set())
    }
    out[index]?.push(write)
    seen[index]?.add(key)
  }
  return out
}

/**
 * Batched upsert inside a caller's transaction. Readings for accounts that no longer exist are
 * dropped rather than failing the batch on the foreign key; the caller must already hold a lock
 * on each named account row that a delete conflicts with. Returns how many rows changed.
 */
export async function upsertQuotaWindowBatch(
  tx: DatabaseExecutor,
  writes: readonly QuotaWindowWrite[],
  live: ReadonlySet<string>,
): Promise<number> {
  let written = 0
  for (const round of rounds(writes.filter((write) => live.has(write.accountId)))) {
    const rows = await tx
      .insert(quotaWindows)
      .values(round.map(insertValues))
      .onConflictDoUpdate(conflict)
      .returning({ id: quotaWindows.id })
    written += rows.length
  }
  return written
}

export function createQuotaWindowMutations(
  db: DatabaseExecutor,
): Pick<
  AccountRepository,
  "upsertQuotaWindow" | "upsertQuotaWindows" | "clearObservedQuotaWindow"
> {
  return {
    upsertQuotaWindow: async (accountId, state) => {
      const [written] = await db
        .insert(quotaWindows)
        .values(insertValues({ accountId, state }))
        .onConflictDoUpdate(conflict)
        .returning()
      if (written !== undefined) return written
      // A rejected stale reading must return held evidence rather than pretend its input committed.
      const [held] = await db
        .select()
        .from(quotaWindows)
        .where(and(eq(quotaWindows.accountId, accountId), eq(quotaWindows.window, state.window)))
      if (held === undefined)
        throw new Error("upsertQuotaWindow: account or window removed during write")
      return held
    },
    upsertQuotaWindows: async (writes) => {
      if (writes.length === 0) return 0
      return db.transaction(async (tx) => {
        // `key share` is the lock a foreign key takes: it holds off a concurrent account delete
        // for the length of the batch without blocking any ordinary account update.
        const ids = [...new Set(writes.map((write) => write.accountId))]
        const held = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(inArray(accounts.id, ids))
          .orderBy(asc(accounts.id))
          .for("key share")
        return upsertQuotaWindowBatch(tx, writes, new Set(held.map((row) => row.id)))
      })
    },
    clearObservedQuotaWindow: async ({ accountId, window, expected, now }) => {
      const [row] = await db
        .update(quotaWindows)
        .set({
          utilization: null,
          retiredAt: sql`clock_timestamp()`,
          evidenceState: "expired",
          blocksRouting: false,
          utilizationSource: "none",
          resetsAt: null,
          resetSource: "unknown",
          revision: sql`${quotaWindows.revision} + 1`,
        })
        .where(
          and(
            eq(quotaWindows.accountId, accountId),
            eq(quotaWindows.window, window),
            eq(quotaWindows.revision, expected.revision),
            eq(quotaWindows.evidenceState, "current"),
            eq(quotaWindows.resetsAt, expected.resetsAt),
            exists(
              db
                .select({ id: accounts.id })
                .from(accounts)
                .where(and(eq(accounts.id, accountId), ne(accounts.status, "exhausted"))),
            ),
            // Caller now is a deterministic scheduler cutoff, DB clock prevents fast host early expiry.
            lte(quotaWindows.resetsAt, now),
            lte(quotaWindows.resetsAt, sql`clock_timestamp()`),
          ),
        )
        .returning()
      return row
    },
  }
}
