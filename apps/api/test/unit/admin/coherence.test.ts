import { describe, expect, test } from "bun:test"
import type { AccountsService } from "../../../src/services/accounts"
import {
  withCatalogRefresh,
  withKeyInvalidation,
  withPoolCatalogRefresh,
} from "../../../src/services/admin/coherence"
import { conflict, ok } from "../../../src/services/admin/result"
import type { KeysService } from "../../../src/services/keys"
import type { PoolsService } from "../../../src/services/pools"

/**
 * The coherence decorators wrap a service and run a hook on the success path
 * only, awaited before the caller sees the result. These pin: which methods
 * trigger a refresh/invalidation and which don't, that a failed write never
 * pays for one, that the hook completes before the decorator returns (so the
 * console really is read-after-write consistent), and that the decorated
 * result is the underlying service's result, untouched.
 */

function trackedRefresh() {
  const calls: string[] = []
  return {
    calls,
    refreshCatalog: async () => {
      calls.push("refresh")
    },
  }
}

function trackedInvalidate() {
  const calls: string[] = []
  return {
    calls,
    invalidateKey: (keyId: string) => {
      calls.push(keyId)
    },
  }
}

const VIEW = { id: "acc-1" } as never
const DELETED = { id: "acc-1", deleted: true as const }

function fakeAccountsService(overrides: Partial<AccountsService> = {}): AccountsService {
  return {
    list: async () => ok([]),
    get: async () => ok(VIEW),
    create: async () => ok(VIEW),
    update: async () => ok(VIEW),
    disable: async () => ok(VIEW),
    remove: async () => ok(DELETED),
    ...overrides,
  }
}

function fakePoolsService(overrides: Partial<PoolsService> = {}): PoolsService {
  return {
    list: async () => ok([]),
    get: async () => ok(VIEW),
    create: async () => ok(VIEW),
    update: async () => ok(VIEW),
    remove: async () => ok(DELETED),
    ...overrides,
  }
}

const REVEALED = { id: "key-1", value: "sk-live-x" } as never
const KEY_VIEW = { id: "key-1" } as never

function fakeKeysService(overrides: Partial<KeysService> = {}): KeysService {
  return {
    list: async () => ok([]),
    get: async () => ok(KEY_VIEW),
    create: async () => ok(KEY_VIEW as never),
    update: async () => ok(KEY_VIEW),
    reveal: async () => ok(REVEALED),
    revoke: async () => ok(KEY_VIEW),
    remove: async () => ok({ id: "key-1", deleted: true as const }),
    ...overrides,
  }
}

describe("withCatalogRefresh", () => {
  test("create, update, disable, and remove each refresh the catalog on success", async () => {
    const hooks = trackedRefresh()
    const service = withCatalogRefresh(fakeAccountsService(), hooks)

    await service.create({} as never)
    await service.update("a", {} as never)
    await service.disable("a")
    await service.remove("a")

    expect(hooks.calls).toEqual(["refresh", "refresh", "refresh", "refresh"])
  })

  test("list and get never trigger a refresh", async () => {
    const hooks = trackedRefresh()
    const service = withCatalogRefresh(fakeAccountsService(), hooks)

    await service.list({})
    await service.get("a")

    expect(hooks.calls).toEqual([])
  })

  test("a failed write is not refreshed", async () => {
    const hooks = trackedRefresh()
    const service = withCatalogRefresh(
      fakeAccountsService({ update: async () => conflict("nope") }),
      hooks,
    )

    const result = await service.update("a", {} as never)

    expect(result.ok).toBe(false)
    expect(hooks.calls).toEqual([])
  })

  test("the refresh is awaited before the result comes back, and the result is untouched", async () => {
    const order: string[] = []
    const hooks = {
      refreshCatalog: async () => {
        order.push("refresh-start")
        await Promise.resolve()
        order.push("refresh-done")
      },
    }
    const service = withCatalogRefresh(fakeAccountsService(), hooks)

    const result = await service.create({} as never)
    order.push("caller-sees-result")

    expect(order).toEqual(["refresh-start", "refresh-done", "caller-sees-result"])
    expect(result).toEqual(ok(VIEW))
  })
})

describe("withPoolCatalogRefresh", () => {
  test("create, update, and remove refresh the catalog on success", async () => {
    const hooks = trackedRefresh()
    const service = withPoolCatalogRefresh(fakePoolsService(), hooks)

    await service.create({} as never)
    await service.update("p", {} as never)
    await service.remove("p")

    expect(hooks.calls).toEqual(["refresh", "refresh", "refresh"])
  })

  test("list and get never trigger a refresh", async () => {
    const hooks = trackedRefresh()
    const service = withPoolCatalogRefresh(fakePoolsService(), hooks)

    await service.list()
    await service.get("p")

    expect(hooks.calls).toEqual([])
  })

  test("a failed write is not refreshed", async () => {
    const hooks = trackedRefresh()
    const service = withPoolCatalogRefresh(
      fakePoolsService({ remove: async () => conflict("nope") }),
      hooks,
    )

    await service.remove("p")

    expect(hooks.calls).toEqual([])
  })
})

describe("withKeyInvalidation", () => {
  test("update, revoke, and remove invalidate that key's cache entry by id", async () => {
    const hooks = trackedInvalidate()
    const service = withKeyInvalidation(fakeKeysService(), hooks)

    await service.update("key-1", {} as never)
    await service.revoke("key-2")
    await service.remove("key-3")

    expect(hooks.calls).toEqual(["key-1", "key-2", "key-3"])
  })

  test("create never invalidates: a key that does not exist yet cannot be cached", async () => {
    const hooks = trackedInvalidate()
    const service = withKeyInvalidation(fakeKeysService(), hooks)

    await service.create({} as never)

    expect(hooks.calls).toEqual([])
  })

  test("list, get, and reveal never invalidate", async () => {
    const hooks = trackedInvalidate()
    const service = withKeyInvalidation(fakeKeysService(), hooks)

    await service.list()
    await service.get("key-1")
    await service.reveal("key-1")

    expect(hooks.calls).toEqual([])
  })

  test("a failed revoke is not invalidated", async () => {
    const hooks = trackedInvalidate()
    const service = withKeyInvalidation(
      fakeKeysService({ revoke: async () => conflict("already revoked") }),
      hooks,
    )

    const result = await service.revoke("key-1")

    expect(result.ok).toBe(false)
    expect(hooks.calls).toEqual([])
  })

  test("invalidation is by the id in the request, not by anything on the returned view", async () => {
    const hooks = trackedInvalidate()
    // The service returns a view for a different id than requested (a receipt for `remove`, say);
    // invalidation must still key off the argument, not the response body.
    const service = withKeyInvalidation(
      fakeKeysService({ update: async () => ok({ id: "not-the-request-id" } as never) }),
      hooks,
    )

    await service.update("key-1", {} as never)

    expect(hooks.calls).toEqual(["key-1"])
  })
})
