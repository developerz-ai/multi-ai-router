import { describe, expect, test } from "bun:test"
import { resolveScopeInput } from "../../../src/services/keys"
import { createMemoryStore } from "../../support/memory-store"

/**
 * Scope targets are checked to exist at write time. Enforcement stays at
 * selection time — this is only about catching a typo where it can still be
 * reported as one, instead of as an empty candidate set hours later.
 */

const MISSING = "11111111-1111-4111-8111-111111111111"

async function seeded() {
  const store = createMemoryStore()
  const account = await store.accounts.create({ label: "zai-1", provider: "zai" })
  const pool = await store.pools.create({ name: "team" })
  return { store, account, pool }
}

describe("all", () => {
  test("names no targets and needs no lookup", async () => {
    const { store } = await seeded()
    const result = await resolveScopeInput(store, { kind: "all" })
    expect(result).toEqual({ ok: true, value: { kind: "all", poolIds: [], accountIds: [] } })
  })
})

describe("pools", () => {
  test("accepts existing pools", async () => {
    const { store, pool } = await seeded()
    const result = await resolveScopeInput(store, { kind: "pools", poolIds: [pool.id] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.poolIds).toEqual([pool.id])
  })

  test("rejects an id no pool has, and names it", async () => {
    const { store, pool } = await seeded()
    const result = await resolveScopeInput(store, { kind: "pools", poolIds: [pool.id, MISSING] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe("unknown_pool")
      expect(result.failure.status).toBe(400)
      expect(result.failure.message).toContain(MISSING)
    }
  })

  test("collapses a repeated id — a duplicate is not a second grant", async () => {
    const { store, pool } = await seeded()
    const result = await resolveScopeInput(store, {
      kind: "pools",
      poolIds: [pool.id, pool.id],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.poolIds).toEqual([pool.id])
  })
})

describe("accounts", () => {
  test("accepts existing accounts", async () => {
    const { store, account } = await seeded()
    const result = await resolveScopeInput(store, { kind: "accounts", accountIds: [account.id] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.accountIds).toEqual([account.id])
  })

  test("rejects an id no account has, and names it", async () => {
    const { store } = await seeded()
    const result = await resolveScopeInput(store, { kind: "accounts", accountIds: [MISSING] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe("unknown_account")
      expect(result.failure.message).toContain(MISSING)
    }
  })

  test("a pool id is not an account id — the two spaces never cross", async () => {
    const { store, pool } = await seeded()
    const result = await resolveScopeInput(store, { kind: "accounts", accountIds: [pool.id] })
    expect(result.ok).toBe(false)
  })
})
