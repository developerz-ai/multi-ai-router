import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { createPoolBody, updatePoolBody } from "../../../src/services/pools/schemas"
import { createPoolsService } from "../../../src/services/pools/service"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"

describe("quotaSoftLimit schema validation", () => {
  it("rejects sub-percent precision on both writes", () => {
    expect(createPoolBody.safeParse({ name: "pool", quotaSoftLimit: 0.804 }).success).toBe(false)
    expect(updatePoolBody.safeParse({ quotaSoftLimit: 0.804 }).success).toBe(false)
  })

  it("preserves an omitted limit and resets null to the default", async () => {
    const store = createMemoryStore()
    const service = createPoolsService({
      pools: store.pools,
      accounts: store.accounts,
      mutations: store.mutations,
      logger: silentLogger(),
      now: () => new Date(),
      onCommitted: () => {},
    })
    const created = await service.create(
      createPoolBody.parse({ name: "pool", quotaSoftLimit: 0.6 }),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error("create failed")
    const id = created.value.id
    const unchanged = await service.update(id, updatePoolBody.parse({ name: "renamed" }))
    expect(unchanged.ok && unchanged.value.quotaSoftLimit).toBe(0.6)
    const cleared = await service.update(id, updatePoolBody.parse({ quotaSoftLimit: null }))
    expect(cleared.ok && cleared.value.quotaSoftLimit).toBe(0.8)
    expect(Number((await store.pools.findById(id))?.quotaSoftLimit)).toBe(0.8)
  })
  const QUOTA_SOFT_LIMIT = z.number().min(0.01).max(0.99)

  describe("QUOTA_SOFT_LIMIT schema", () => {
    it("accepts 0.01 (minimum)", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(0.01)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data).toBe(0.01)
    })

    it("accepts 0.5", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(0.5)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data).toBe(0.5)
    })

    it("accepts 0.8", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(0.8)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data).toBe(0.8)
    })

    it("accepts 0.99 (maximum)", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(0.99)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data).toBe(0.99)
    })

    it("rejects 0 (below minimum)", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(0)
      expect(result.success).toBe(false)
    })

    it("rejects 1 (above maximum)", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(1)
      expect(result.success).toBe(false)
    })

    it("rejects negative values", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(-0.1)
      expect(result.success).toBe(false)
    })

    it("rejects values greater than 1", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(1.1)
      expect(result.success).toBe(false)
    })

    it("rejects non-numeric values", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse("0.8")
      expect(result.success).toBe(false)
    })

    it("rejects null", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(null)
      expect(result.success).toBe(false)
    })

    it("rejects undefined", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse(undefined)
      expect(result.success).toBe(false)
    })

    it("rejects arrays", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse([0.8])
      expect(result.success).toBe(false)
    })

    it("rejects objects", () => {
      const result = QUOTA_SOFT_LIMIT.safeParse({ value: 0.8 })
      expect(result.success).toBe(false)
    })
  })

  describe("createPoolBody quotaSoftLimit", () => {
    it("accepts valid quotaSoftLimit values", () => {
      const validValues = [0.01, 0.5, 0.8, 0.99]
      for (const value of validValues) {
        const result = createPoolBody.safeParse({
          name: "test-pool",
          quotaSoftLimit: value,
        })
        expect(result.success).toBe(true)
        if (result.success) expect(result.data.quotaSoftLimit).toBe(value)
      }
    })

    it("omitted quotaSoftLimit is undefined (default applied at DB level)", () => {
      const result = createPoolBody.safeParse({ name: "test-pool" })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.quotaSoftLimit).toBeUndefined()
    })

    it("rejects negative quotaSoftLimit", () => {
      const result = createPoolBody.safeParse({ name: "test-pool", quotaSoftLimit: -0.1 })
      expect(result.success).toBe(false)
    })

    it("rejects quotaSoftLimit > 1", () => {
      const result = createPoolBody.safeParse({ name: "test-pool", quotaSoftLimit: 1.1 })
      expect(result.success).toBe(false)
    })

    it("rejects quotaSoftLimit = 0 (below minimum)", () => {
      const result = createPoolBody.safeParse({ name: "test-pool", quotaSoftLimit: 0 })
      expect(result.success).toBe(false)
    })

    it("rejects quotaSoftLimit = 1 (above maximum)", () => {
      const result = createPoolBody.safeParse({ name: "test-pool", quotaSoftLimit: 1 })
      expect(result.success).toBe(false)
    })

    it("rejects non-numeric quotaSoftLimit", () => {
      const result = createPoolBody.safeParse({ name: "test-pool", quotaSoftLimit: "0.8" })
      expect(result.success).toBe(false)
    })

    it("rejects null quotaSoftLimit on create", () => {
      const result = createPoolBody.safeParse({ name: "test-pool", quotaSoftLimit: null })
      expect(result.success).toBe(false)
    })
  })

  describe("updatePoolBody quotaSoftLimit", () => {
    it("accepts valid quotaSoftLimit values", () => {
      const validValues = [0.01, 0.5, 0.8, 0.99]
      for (const value of validValues) {
        const result = updatePoolBody.safeParse({ quotaSoftLimit: value })
        expect(result.success).toBe(true)
        if (result.success) expect(result.data.quotaSoftLimit).toBe(value)
      }
    })

    it("accepts null to clear quotaSoftLimit", () => {
      const result = updatePoolBody.safeParse({ quotaSoftLimit: null })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.quotaSoftLimit).toBeNull()
    })

    it("allows omitting quotaSoftLimit", () => {
      const result = updatePoolBody.safeParse({ name: "updated-pool" })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.quotaSoftLimit).toBeUndefined()
    })

    it("rejects negative quotaSoftLimit", () => {
      const result = updatePoolBody.safeParse({ quotaSoftLimit: -0.1 })
      expect(result.success).toBe(false)
    })

    it("rejects quotaSoftLimit > 1", () => {
      const result = updatePoolBody.safeParse({ quotaSoftLimit: 1.1 })
      expect(result.success).toBe(false)
    })

    it("rejects quotaSoftLimit = 0 (below minimum)", () => {
      const result = updatePoolBody.safeParse({ quotaSoftLimit: 0 })
      expect(result.success).toBe(false)
    })

    it("rejects quotaSoftLimit = 1 (above maximum)", () => {
      const result = updatePoolBody.safeParse({ quotaSoftLimit: 1 })
      expect(result.success).toBe(false)
    })

    it("rejects non-numeric quotaSoftLimit", () => {
      const result = updatePoolBody.safeParse({ quotaSoftLimit: "0.8" })
      expect(result.success).toBe(false)
    })

    it("rejects empty patch", () => {
      const result = updatePoolBody.safeParse({})
      expect(result.success).toBe(false)
    })
  })
})
