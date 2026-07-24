import { describe, expect, test } from "bun:test"
import { RoutingPolicy } from "@multi-ai-router/core"
import { createAuditRecorder } from "../../../src/services/admin"
import { createPoolBody, createPoolsService, updatePoolBody } from "../../../src/services/pools"
import { createMemoryStore, type MemoryStore } from "../../support/memory-store"

/**
 * Pools own the routing policy and the membership routing reads. The rule under
 * test throughout is that a pool never comes to reference an account that does
 * not exist — checked at write time, because at selection time it is only
 * visible as a candidate set that is mysteriously too small.
 */

const NOW = new Date("2026-07-24T12:00:00.000Z")
const MISSING = "11111111-1111-4111-8111-111111111111"

function harness(): { service: ReturnType<typeof createPoolsService>; store: MemoryStore } {
  const store = createMemoryStore()
  const service = createPoolsService({
    pools: store.pools,
    accounts: store.accounts,
    keys: store.keys,
    audit: createAuditRecorder(store.audit),
    now: () => NOW,
  })
  return { service, store }
}

async function seeded() {
  const { service, store } = harness()
  const account = await store.accounts.create({ label: "zai-1", provider: "zai" })
  const spare = await store.accounts.create({ label: "openrouter-1", provider: "openrouter" })
  return { service, store, account, spare }
}

describe("create", () => {
  test("defaults to the sticky policy and holds the members it was given", async () => {
    const { service, account } = await seeded()
    const result = await service.create({
      name: "team",
      members: [{ accountId: account.id, weight: 250, priority: 1 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.policy).toBe("sticky")
    expect(result.value.members).toEqual([
      {
        accountId: account.id,
        label: "zai-1",
        provider: "zai",
        status: "active",
        weight: 250,
        priority: 1,
      },
    ])
  })

  test("rejects a member naming an account that does not exist, and writes nothing", async () => {
    const { service, store } = await seeded()
    const result = await service.create({ name: "team", members: [{ accountId: MISSING }] })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe("unknown_account")
      expect(result.failure.message).toContain(MISSING)
    }
    expect(store.rows.pools).toHaveLength(0)
    expect(store.rows.audit).toHaveLength(0)
  })

  test("rejects the same account listed twice", async () => {
    const { service, account } = await seeded()
    const result = await service.create({
      name: "team",
      members: [{ accountId: account.id }, { accountId: account.id }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe("duplicate_member")
  })

  test("rejects an overflow account that is not a real account", async () => {
    const { service } = await seeded()
    const result = await service.create({ name: "team", overflowAccountId: MISSING })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe("unknown_overflow_account")
  })

  test("accepts an overflow account that is not a member — it is a last resort, not a member", async () => {
    const { service, account, spare } = await seeded()
    const result = await service.create({
      name: "team",
      members: [{ accountId: account.id }],
      overflowAccountId: spare.id,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overflowAccountId).toBe(spare.id)
      expect(result.value.members.map((member) => member.accountId)).toEqual([account.id])
    }
  })

  test("names are unique", async () => {
    const { service } = await seeded()
    await service.create({ name: "team" })
    const again = await service.create({ name: "team" })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.failure.status).toBe(409)
  })
})

describe("update", () => {
  test("replaces the membership as a whole set", async () => {
    const { service, store, account, spare } = await seeded()
    const pool = await service.create({ name: "team", members: [{ accountId: account.id }] })
    if (!pool.ok) throw new Error("setup failed")

    const updated = await service.update(pool.value.id, { members: [{ accountId: spare.id }] })
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      expect(updated.value.members.map((member) => member.accountId)).toEqual([spare.id])
    }
    expect(store.rows.poolMembers).toHaveLength(1)
  })

  test("clears the overflow account when it is explicitly set to null", async () => {
    const { service, spare } = await seeded()
    const pool = await service.create({ name: "team", overflowAccountId: spare.id })
    if (!pool.ok) throw new Error("setup failed")

    const updated = await service.update(pool.value.id, { overflowAccountId: null })
    expect(updated.ok && updated.value.overflowAccountId).toBeNull()
  })

  test("records the policy change on both sides, which is what a routing question starts from", async () => {
    const { service, store } = await seeded()
    const pool = await service.create({ name: "team" })
    if (!pool.ok) throw new Error("setup failed")

    await service.update(pool.value.id, { policy: "quota-aware" })
    expect(store.rows.audit.at(-1)).toMatchObject({ kind: "pool.updated" })
    expect(store.rows.audit.at(-1)?.detail).toMatchObject({
      policyBefore: "sticky",
      policyAfter: "quota-aware",
    })
  })

  test("an unknown pool is a 404", async () => {
    const { service } = await seeded()
    const result = await service.update(MISSING, { name: "x" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.status).toBe(404)
  })
})

describe("delete", () => {
  test("refuses while a key's scope names the pool, and says which key", async () => {
    const { service, store } = await seeded()
    const pool = await service.create({ name: "team" })
    if (!pool.ok) throw new Error("setup failed")

    const key = await store.keys.create({
      name: "ci-agent-3",
      value: "v1.k1.x",
      prefix: "mar_live_",
    })
    await store.keys.replaceScopeTargets(key.id, { poolIds: [pool.value.id] })

    const result = await service.remove(pool.value.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.status).toBe(409)
      expect(result.failure.message).toContain("ci-agent-3")
    }
  })

  test("removes an unreferenced pool and audits it", async () => {
    const { service, store } = await seeded()
    const pool = await service.create({ name: "team" })
    if (!pool.ok) throw new Error("setup failed")

    expect((await service.remove(pool.value.id)).ok).toBe(true)
    expect(store.rows.pools).toHaveLength(0)
    expect(store.rows.audit.at(-1)?.kind).toBe("pool.deleted")
  })
})

describe("policy validation", () => {
  test("accepts each of core's six policies and nothing else", () => {
    for (const policy of RoutingPolicy.options) {
      expect(createPoolBody.safeParse({ name: "team", policy }).success).toBe(true)
    }
    expect(createPoolBody.safeParse({ name: "team", policy: "random" }).success).toBe(false)
    expect(updatePoolBody.safeParse({ policy: "cheapest" }).success).toBe(false)
  })
})

describe("write schemas", () => {
  test("reject an unnamed pool, an unknown field, and a non-uuid member", () => {
    expect(createPoolBody.safeParse({}).success).toBe(false)
    expect(createPoolBody.safeParse({ name: "t", surprise: 1 }).success).toBe(false)
    expect(createPoolBody.safeParse({ name: "t", members: [{ accountId: "x" }] }).success).toBe(
      false,
    )
  })

  test("reject a zero weight — it would silently drop the member from the weighted policy", () => {
    expect(
      createPoolBody.safeParse({ name: "t", members: [{ accountId: MISSING, weight: 0 }] }).success,
    ).toBe(false)
  })

  test("reject an empty update", () => {
    expect(updatePoolBody.safeParse({}).success).toBe(false)
  })
})
