import { describe, expect, test } from "bun:test"
import { createSessionCache, type SessionEntry } from "../../../src/providers"
import { ticker } from "./fixtures"

/**
 * The cache pair and its one invariant: **coordinated eviction**
 * (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * Dropping an entry from one cache must remove every entry in the other naming the same SDK
 * session id. A half-evicted pair is the failure this exists to prevent: the fingerprint side has
 * no row to re-read, so it would keep handing out a resume token for a lineage the session side
 * already abandoned, and the next turn would splice two histories together.
 */

const entry = (sdkSessionId: string, accountId = "acct-1"): SessionEntry => ({
  accountId,
  sdkSessionId,
  lineage: { prefixHashes: ["h1"], assistantUuids: [""] },
})

const cacheWith = (maxEntries = 8, clock = ticker()) =>
  createSessionCache({ maxEntries, ttlMs: 1_000, negativeTtlMs: 100, now: clock.now })

describe("the session cache", () => {
  test("distinguishes never-looked-up from looked-up-and-unbound", () => {
    const cache = cacheWith()

    expect(cache.get("missing")).toBeUndefined()
    cache.set("known", null)
    expect(cache.get("known")).toBeNull()
  })

  test("a miss is remembered on its own shorter clock", () => {
    const clock = ticker()
    const cache = cacheWith(8, clock)

    cache.set("k", null)
    clock.advance(99)
    expect(cache.get("k")).toBeNull()
    clock.advance(2)
    expect(cache.get("k")).toBeUndefined()
  })

  test("a binding outlives a miss, and still expires", () => {
    const clock = ticker()
    const cache = cacheWith(8, clock)

    cache.set("k", entry("sess_1"))
    clock.advance(999)
    expect(cache.get("k")).not.toBeNull()
    clock.advance(2)
    expect(cache.get("k")).toBeUndefined()
  })

  test("eviction is least-recently-used, not first-in", () => {
    const cache = cacheWith(2)

    cache.set("a", entry("sess_a"))
    cache.set("b", entry("sess_b"))
    cache.get("a")
    cache.set("c", entry("sess_c"))

    expect(cache.get("a")).not.toBeUndefined()
    expect(cache.get("b")).toBeUndefined()
  })

  test("refreshing a key's own binding does not disturb its fingerprint alias", () => {
    const cache = cacheWith()

    cache.set("k", entry("sess_1"))
    cache.alias("fp", "k")
    cache.set("k", entry("sess_1"))

    expect(cache.aliased("fp")).toBe("k")
  })
})

describe("coordinated eviction", () => {
  test("dropping the session entry takes every fingerprint naming its session id", () => {
    const cache = cacheWith()

    cache.set("k", entry("sess_1"))
    cache.alias("fp-one", "k")
    cache.alias("fp-two", "k")
    expect(cache.aliases).toBe(2)

    cache.drop("k")

    expect(cache.get("k")).toBeUndefined()
    expect(cache.aliased("fp-one")).toBeUndefined()
    expect(cache.aliased("fp-two")).toBeUndefined()
  })

  test("evicting a fingerprint takes the session entry it named", () => {
    const cache = cacheWith(3)

    cache.set("k", entry("sess_1"))
    cache.set("j", entry("sess_2"))
    cache.set("m", entry("sess_3"))
    // A fourth alias against a cap of three pushes the oldest out, and it takes the session entry
    // it named with it.
    cache.alias("fp-one", "k")
    cache.alias("fp-two", "j")
    cache.alias("fp-three", "m")
    cache.alias("fp-four", "m")

    expect(cache.aliased("fp-one")).toBeUndefined()
    expect(cache.get("k")).toBeUndefined()
    expect(cache.get("j")).not.toBeUndefined()
    expect(cache.aliased("fp-three")).toBe("m")
  })

  test("capacity eviction of a session entry is coordinated too", () => {
    const cache = cacheWith(2)

    cache.set("a", entry("sess_a"))
    cache.alias("fp-a", "a")
    cache.set("b", entry("sess_b"))
    cache.set("c", entry("sess_c"))

    expect(cache.get("a")).toBeUndefined()
    expect(cache.aliased("fp-a")).toBeUndefined()
  })

  test("an expired binding takes its aliases with it rather than leaving them resolvable", () => {
    const clock = ticker()
    const cache = cacheWith(8, clock)

    cache.set("k", entry("sess_1"))
    cache.alias("fp", "k")
    clock.advance(1_001)

    expect(cache.get("k")).toBeUndefined()
    expect(cache.aliased("fp")).toBeUndefined()
  })

  test("the SDK reporting a session gone forgets it under every name", () => {
    const cache = cacheWith()

    cache.set("k", entry("sess_1"))
    cache.set("k2", entry("sess_1"))
    cache.alias("fp", "k")
    cache.set("other", entry("sess_2"))

    cache.forget("sess_1")

    expect(cache.get("k")).toBeUndefined()
    expect(cache.get("k2")).toBeUndefined()
    expect(cache.aliased("fp")).toBeUndefined()
    // Unrelated sessions are untouched: one gone session is not a cache flush.
    expect(cache.get("other")).not.toBeUndefined()
  })

  test("an alias with nothing to point at is not stored", () => {
    const cache = cacheWith()

    cache.alias("fp", "never-set")
    cache.set("unbound", null)
    cache.alias("fp2", "unbound")

    expect(cache.aliases).toBe(0)
  })

  test("rebinding a key onto a new session id drops the old id's aliases", () => {
    const cache = cacheWith()

    cache.set("k", entry("sess_1"))
    cache.alias("fp", "k")
    cache.set("k", entry("sess_2"))

    expect(cache.aliased("fp")).toBeUndefined()
    expect(cache.get("k")).toMatchObject({ sdkSessionId: "sess_2" })
  })

  test("maxEntries below one is a construction error, not a cache that evicts everything", () => {
    expect(() => createSessionCache({ maxEntries: 0, ttlMs: 1, negativeTtlMs: 1 })).toThrow()
  })
})
