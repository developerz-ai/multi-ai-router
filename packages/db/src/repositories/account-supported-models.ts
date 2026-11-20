import { eq } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import {
  type AccountRow,
  accounts,
  type SupportedModelList,
  type SupportedModelRemoval,
} from "../schema/accounts"

/**
 * The one writer of `accounts.supported_models` after the insert.
 *
 * A read-modify-write of a several-hundred-entry list is a lost update the moment two operators
 * (or an operator and "Discover models") edit it at once: each reads the same list, each writes its
 * own copy, and the second silently drops the first one's id. So the read and the write happen in
 * one transaction under the row's lock (`SELECT … FOR UPDATE`), and the caller's `decide` sees the
 * row as it is *now*, after every earlier writer committed. Two concurrent add-one calls serialize
 * here and both land.
 *
 * `decide` is the caller's rule (which ids may leave, and which removals are remembered); this
 * module owns only the SQL and the lock. It must be synchronous and pure: it runs while the lock is
 * held.
 */
export type SupportedModelsDecision =
  | {
      readonly kind: "write"
      readonly supportedModels: SupportedModelList | null
      readonly supportedModelsRemoved: SupportedModelRemoval[] | null
    }
  /** Nothing to write: a refusal, or an edit that changes nothing. The lock is released unwritten. */
  | { readonly kind: "skip" }

export type SupportedModelsEditResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "skipped"; readonly row: AccountRow }
  | { readonly kind: "written"; readonly row: AccountRow }

export interface SupportedModelsMethods {
  editSupportedModels(input: {
    readonly id: string
    readonly now: Date
    readonly decide: (row: AccountRow) => SupportedModelsDecision
  }): Promise<SupportedModelsEditResult>
}

export function createSupportedModelsMethods(db: DatabaseExecutor): SupportedModelsMethods {
  return {
    editSupportedModels: ({ id, now, decide }) =>
      db.transaction(async (tx) => {
        const [current] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update")
        if (current === undefined) return { kind: "not_found" as const }
        const decision = decide(current)
        if (decision.kind === "skip") return { kind: "skipped" as const, row: current }
        const [row] = await tx
          .update(accounts)
          .set({
            supportedModels: decision.supportedModels,
            supportedModelsRemoved: decision.supportedModelsRemoved,
            updatedAt: now,
          })
          .where(eq(accounts.id, id))
          .returning()
        if (row === undefined) throw new Error("editSupportedModels: locked row disappeared")
        return { kind: "written" as const, row }
      }),
  }
}
