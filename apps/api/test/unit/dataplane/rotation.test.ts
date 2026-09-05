import { describe, expect, test } from "bun:test"
import {
  buildSnapshot,
  createHealthStore,
  createRotationCounters,
} from "../../../src/services/dataplane"
import { account, catalog, NOW } from "./fixtures"

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
