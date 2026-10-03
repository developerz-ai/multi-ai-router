import type { AdminMutationRepository, AdminMutationScope } from "@multi-ai-router/db"
import type { MemoryStore } from "./memory-store"

/** Serial transactions with rollback, over the same rows existing service fixtures inspect. */
export function createMemoryMutations(store: MemoryStore): AdminMutationRepository {
  let preceding = Promise.resolve()
  return {
    async run(_subject, work) {
      let release = () => {}
      const turn = new Promise<void>((resolve) => {
        release = resolve
      })
      const previous = preceding
      preceding = turn
      await previous
      const snapshots = Object.values(store.rows).map((rows) => ({
        rows: rows as unknown[],
        before: structuredClone(rows) as unknown[],
      }))
      const scope: AdminMutationScope = {
        keys: store.keys,
        pools: store.pools,
        accounts: store.accounts,
        audit: store.audit,
      }
      try {
        return await work(scope)
      } catch (error) {
        for (const { rows, before } of snapshots) rows.splice(0, rows.length, ...before)
        throw error
      } finally {
        release()
      }
    },
  }
}
