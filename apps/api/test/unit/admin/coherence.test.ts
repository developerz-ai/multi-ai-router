import { describe, expect, test } from "bun:test"
import type { AccountsService } from "../../../src/services/accounts"
import { keyMutationCommitted, withCatalogRefresh } from "../../../src/services/admin/coherence"
import { conflict, ok } from "../../../src/services/admin/result"
import { createRateLimiter } from "../../../src/services/dataplane/limits"

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

describe("committed key mutations", () => {
  function setup() {
    const limiter = createRateLimiter()
    const invalidated: string[] = []
    const key = { id: "key-1", rateLimitRequests: 1, rateLimitWindowSeconds: 60 }
    const hooks = {
      invalidateKey: (id: string) => {
        invalidated.push(id)
      },
      forgetKey: (id: string) => {
        invalidated.push(id)
        limiter.forget(id)
      },
    }
    return { limiter, invalidated, key, hooks }
  }

  test("a rename or scope edit invalidates authorization without granting a new rate window", () => {
    const { limiter, invalidated, key, hooks } = setup()
    expect(limiter.check(key, 0).allowed).toBe(true)
    keyMutationCommitted(hooks, key.id, "update")
    expect(invalidated).toEqual([key.id])
    expect(limiter.check(key, 1).allowed).toBe(false)
    // Changed limits are recognized by the limiter, without resetting unrelated edits.
    expect(limiter.check({ ...key, rateLimitRequests: 2 }, 2).allowed).toBe(true)
  })

  for (const kind of ["revoke", "remove"] as const) {
    test(`${kind} drops authorization and retained rate-limit state`, () => {
      const { limiter, invalidated, key, hooks } = setup()
      limiter.check(key, 0)
      keyMutationCommitted(hooks, key.id, kind)
      expect(invalidated).toEqual([key.id])
      expect(limiter.size).toBe(0)
    })
  }

  test("minting a new key does not invalidate existing state", () => {
    const { invalidated, key, hooks } = setup()
    keyMutationCommitted(hooks, key.id, "create")
    expect(invalidated).toEqual([])
  })
})
