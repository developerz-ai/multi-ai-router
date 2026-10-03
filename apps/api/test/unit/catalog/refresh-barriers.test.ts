import { describe, expect, test } from "bun:test"
import { createRoutingCatalog } from "../../../src/services/catalog"
import { createPriceBook } from "../../../src/services/cost"
import { createModelCatalogStore } from "../../../src/services/models"

interface Store {
  refresh(): Promise<void>
  refreshAfterMutation(): Promise<void>
  loadedAt(): Date | null
  value(): number | undefined
}

type Factory = (load: () => Promise<number>, now: () => Date) => Store
const factories: Record<string, Factory> = {
  routing: (load, now) => {
    const store = createRoutingCatalog({
      load: async () => ({
        accounts: [],
        pools: [{ id: "pool", name: String(await load()), policy: "sticky", members: [] }],
      }),
      now,
      refreshIntervalMs: 60_000,
    })
    return {
      ...store,
      value: () => {
        const name = store.pools()[0]?.name
        return name === undefined ? undefined : Number(name)
      },
    }
  },
  prices: (load, now) => {
    const store = createPriceBook({
      load: async () => [
        {
          id: "price",
          provider: "openai-api",
          model: "test-model",
          inputPerMtok: await load(),
          outputPerMtok: 1,
          cacheReadPerMtok: 0,
          cacheWritePerMtok: 0,
          createdAt: now(),
          updatedAt: now(),
        },
      ],
      now,
      refreshIntervalMs: 60_000,
    })
    return { ...store, value: () => store.lookup("openai-api", "test-model")?.inputPerMtok }
  },
  models: (load, now) => {
    const store = createModelCatalogStore({
      load: async () => [
        {
          accountId: "account",
          modelId: "test-model",
          contextTokens: await load(),
          maxOutputTokens: null,
          contextSource: "upstream",
          listingSource: "upstream",
          resolvedModel: null,
          refreshedAt: now(),
        },
      ],
      now,
      refreshIntervalMs: 60_000,
    })
    return {
      ...store,
      value: () => store.describe("account", "test-model")?.contextTokens ?? undefined,
    }
  },
}

function controlled() {
  const reads = Array.from({ length: 8 }, () => ({
    started: Promise.withResolvers<void>(),
    result: Promise.withResolvers<number>(),
  }))
  let count = 0
  return {
    load: () => {
      const read = reads[count++]
      if (read === undefined) throw new Error("unexpected extra snapshot read")
      read.started.resolve()
      return read.result.promise
    },
    read: async (index: number) => {
      const read = reads[index]
      if (read === undefined) throw new Error("missing controlled read")
      await read.started.promise
      return read.result
    },
    count: () => count,
  }
}

for (const [name, create] of Object.entries(factories)) {
  describe(`${name} post-mutation freshness`, () => {
    test("ordinary concurrent refreshes share a read", async () => {
      const source = controlled()
      const store = create(source.load, () => new Date(1))
      const first = store.refresh()
      const second = store.refresh()
      expect(second).toBe(first)
      ;(await source.read(0)).resolve(1)
      await Promise.all([first, second])
      expect(source.count()).toBe(1)
      expect(store.value()).toBe(1)
    })

    test("a mutation waits for a trailing read and never installs the obsolete result", async () => {
      const source = controlled()
      let now = new Date(1)
      const store = create(source.load, () => now)
      const initial = store.refresh()
      ;(await source.read(0)).resolve(1)
      await initial
      const old = store.refresh()
      await source.read(1)
      now = new Date(2)
      let finished = false
      const mutation = store.refreshAfterMutation().then(() => {
        finished = true
      })
      ;(await source.read(1)).resolve(2)
      await old
      const fresh = await source.read(2)
      expect(finished).toBe(false)
      expect(store.value()).toBe(1)
      expect(store.loadedAt()).toEqual(new Date(1))
      fresh.resolve(3)
      await mutation
      expect(store.value()).toBe(3)
      expect(store.loadedAt()).toEqual(new Date(2))
    })

    test("queued mutations coalesce; a mutation during the trailing read requires another", async () => {
      const source = controlled()
      const store = create(source.load, () => new Date(1))
      const old = store.refresh()
      const read = await source.read(0)
      let finished = 0
      const mutations = [store.refreshAfterMutation(), store.refreshAfterMutation()].map(
        (pending) =>
          pending.then(() => {
            finished++
          }),
      )
      read.resolve(1)
      await old
      const trailing = await source.read(1)
      mutations.push(
        store.refreshAfterMutation().then(() => {
          finished++
        }),
      )
      trailing.resolve(2)
      const newest = await source.read(2)
      expect(finished).toBe(0)
      expect(store.value()).toBeUndefined()
      newest.resolve(3)
      await Promise.all(mutations)
      expect(source.count()).toBe(3)
      expect(finished).toBe(3)
      expect(store.value()).toBe(3)
    })

    test("an obsolete read failure does not suppress a committed mutation's reload", async () => {
      const source = controlled()
      const store = create(source.load, () => new Date(1))
      const old = store.refresh()
      const failed = old.catch((error: unknown) => error)
      const read = await source.read(0)
      const mutation = store.refreshAfterMutation()
      read.reject(new Error("old read failed"))
      expect(await failed).toMatchObject({ message: "old read failed" })
      ;(await source.read(1)).resolve(2)
      await mutation
      expect(store.value()).toBe(2)
    })

    test("a current read failure rejects without clearing the last good snapshot", async () => {
      const source = controlled()
      const store = create(source.load, () => new Date(1))
      const initial = store.refresh()
      ;(await source.read(0)).resolve(1)
      await initial
      const mutation = store.refreshAfterMutation()
      const failed = mutation.catch((error: unknown) => error)
      ;(await source.read(1)).reject(new Error("fresh read failed"))
      expect(await failed).toMatchObject({ message: "fresh read failed" })
      expect(store.value()).toBe(1)
      const retry = store.refreshAfterMutation()
      ;(await source.read(2)).resolve(3)
      await retry
      expect(store.value()).toBe(3)
    })
  })
}
