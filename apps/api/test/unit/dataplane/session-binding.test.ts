import { describe, expect, test } from "bun:test"
import type { SessionStore } from "../../../src/providers"
import { sessionBindings } from "../../../src/services/dataplane"
import { account, catalog, subscriptionAccount } from "./fixtures"

/**
 * The gate in front of the binding lookup.
 *
 * Only the Agent-SDK path ever writes a binding, so a router with no subscription Account has
 * nothing to look up — and looking anyway would put one indexed query on every request of a
 * deployment that can never benefit from it (CLAUDE.md non-negotiable 8). The catalog is read per
 * call rather than captured, so an Account added at runtime starts binding on the next request.
 */

function spyStore(): SessionStore & { readonly reads: string[]; readonly dropped: string[] } {
  const reads: string[] = []
  const dropped: string[] = []
  return {
    reads,
    dropped,
    binding: async (apiKeyId, sessionKey) => {
      reads.push(`${apiKeyId}/${sessionKey}`)
      return { accountId: "acct-1", sdkSessionId: "sess_1" }
    },
    invalidate: (apiKeyId, sessionKey) => {
      dropped.push(`${apiKeyId}/${sessionKey}`)
    },
    resolve: () => ({
      plan: { kind: "fresh", reason: "no-session" },
      remember: () => {},
      release: () => {},
    }),
  }
}

describe("whether a request has a binding to read at all", () => {
  test("no store wired: no binding, and nothing to fail", async () => {
    const bindings = sessionBindings(catalog([account("api-1")]), undefined)

    expect(await bindings.read("key-1", "conv-1")).toBeUndefined()
    expect(() => bindings.invalidate("key-1", "conv-1")).not.toThrow()
  })

  test("a router with only HTTP accounts never queries", async () => {
    const store = spyStore()
    const bindings = sessionBindings(catalog([account("api-1")]), store)

    expect(await bindings.read("key-1", "conv-1")).toBeUndefined()
    expect(store.reads).toHaveLength(0)
  })

  test("one subscription account anywhere in the catalog turns the lookup on", async () => {
    const store = spyStore()
    const store2 = catalog([account("api-1"), subscriptionAccount("sub")])
    const bindings = sessionBindings(store2, store)

    expect(await bindings.read("key-1", "conv-1")).toMatchObject({ accountId: "acct-1" })
    expect(store.reads).toEqual(["key-1/conv-1"])
  })

  test("invalidation is forwarded whatever the catalog holds — a binding must always be droppable", () => {
    const store = spyStore()
    sessionBindings(catalog([account("api-1")]), store).invalidate("key-1", "conv-1")

    expect(store.dropped).toEqual(["key-1/conv-1"])
  })
})
