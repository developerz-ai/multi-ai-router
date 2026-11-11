import { describe, expect, test } from "bun:test"
import {
  buildSnapshot,
  createDispatcher,
  createHealthStore,
  createRotationCounters,
} from "../../../src/services/dataplane"
import { account, catalog, cipher, jsonResponse, NOW } from "./fixtures"

/**
 * The caller-owned half of `round-robin`: a counter per pool that advances once per placement.
 * Without it every rotation policy ran at `0` forever — twenty new sessions on a six-account
 * `round-robin` pool all landed on the first member.
 */

describe("rotation counters", () => {
  test("start at zero and advance per pool, independently", () => {
    const rotation = createRotationCounters()
    expect(rotation.current("subs")).toBe(0)
    expect(rotation.current("paid")).toBe(0)

    rotation.advance("subs")
    rotation.advance("subs")
    rotation.advance("paid")

    // Another pool's traffic never strides this pool's rotation.
    expect(rotation.current("subs")).toBe(2)
    expect(rotation.current("paid")).toBe(1)
  })

  test("the unpooled flat group has a counter of its own", () => {
    const rotation = createRotationCounters()
    rotation.advance(null)
    expect(rotation.current(null)).toBe(1)
    expect(rotation.current("subs")).toBe(0)
  })
})

describe("the snapshot carries each pool's counter", () => {
  const accounts = [account("a"), account("b")]
  const pools = [{ id: "subs", name: "subs", policy: "round-robin" as const, members: [] }]

  test("stamped from the rotation the dispatcher owns", () => {
    const rotation = createRotationCounters()
    rotation.advance("subs")
    rotation.advance("subs")
    rotation.advance("subs")

    const snapshot = buildSnapshot(catalog(accounts, pools), createHealthStore(), NOW, rotation)
    expect(snapshot.pools[0]?.rotationCounter).toBe(3)
  })

  test("left as the catalog holds it when no rotation is supplied", () => {
    const snapshot = buildSnapshot(catalog(accounts, pools), createHealthStore(), NOW)
    expect(snapshot.pools[0]?.rotationCounter).toBeUndefined()
  })
})

describe("the dispatcher advances only the pool that placed the head (03.2)", () => {
  // K1 is scoped to pools [A, B] and is always served by A; K2 is scoped to [B] alone. Advancing
  // every pool in K1's scope strode B by two per round, so K2 landed on one B member forever.
  const accounts = [account("a1"), account("b1"), account("b2")]
  const pools = [
    { id: "A", name: "A", policy: "round-robin" as const, members: [{ accountId: "a1" }] },
    {
      id: "B",
      name: "B",
      policy: "round-robin" as const,
      members: [{ accountId: "b1" }, { accountId: "b2" }],
    },
  ]
  const served: string[] = []
  const dispatcher = createDispatcher({
    catalog: catalog(accounts, pools),
    health: createHealthStore(),
    cipher: cipher(),
    usage: { record: (row) => void (row.accountId === null ? null : served.push(row.accountId)) },
    fetch: async () => jsonResponse(200, { type: "message", content: [] }),
  })
  const send = (keyId: string, poolIds: readonly string[]) =>
    dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: keyId,
        name: keyId,
        prefix: keyId,
        scope: { kind: "pools", poolIds: [...poolIds] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          max_tokens: 1,
          messages: [{ role: "user", content: "x" }],
        }),
      }),
    })

  test("K2 alternates across B while K1 is served from A", async () => {
    const k2: string[] = []
    for (let round = 0; round < 4; round++) {
      await (await send("k1", ["A", "B"])).text()
      const before = served.length
      await (await send("k2", ["B"])).text()
      k2.push(...served.slice(before))
    }
    expect(k2).toHaveLength(4)
    for (let index = 1; index < k2.length; index++) expect(k2[index]).not.toBe(k2[index - 1])
  })
})
