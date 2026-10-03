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
      const restore = Object.values(store.rows).map((collection) => {
        if (collection instanceof Map) {
          const before = structuredClone(collection)
          return () => {
            collection.clear()
            for (const [id, recovery] of before) collection.set(id, recovery)
          }
        }
        const rows = collection as unknown[]
        const before = structuredClone(rows)
        return () => rows.splice(0, rows.length, ...before)
      })
      const scope: AdminMutationScope = {
        keys: store.keys,
        pools: store.pools,
        accounts: store.accounts,
        audit: store.audit,
      }
      try {
        return await work(scope)
      } catch (error) {
        for (const rollback of restore) rollback()
        throw error
      } finally {
        release()
      }
    },
  }
}
