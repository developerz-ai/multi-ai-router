import { describe, expect, test } from "bun:test"
import { createPoolBody, updatePoolBody } from "../../../src/services/pools/schemas"

describe("quotaSoftLimit schema validation", () => {
  const base = { name: "pool", members: [] }

  test("accepts 0 (no soft limit)", () => {
    expect(createPoolBody.safeParse({ ...base, quotaSoftLimit: 0 }).success).toBe(true)
  })

  test("accepts 0.5 (mid-window)", () => {
    expect(createPoolBody.safeParse({ ...base, quotaSoftLimit: 0.5 }).success).toBe(true)
  })

  test("accepts 0.8 (default)", () => {
    expect(createPoolBody.safeParse({ ...base, quotaSoftLimit: 0.8 }).success).toBe(true)
  })

  test("accepts 1 (never soft-limited)", () => {
    expect(createPoolBody.safeParse({ ...base, quotaSoftLimit: 1 }).success).toBe(true)
  })

  test("rejects below zero", () => {
    expect(createPoolBody.safeParse({ ...base, quotaSoftLimit: -0.01 }).success).toBe(false)
  })

  test("rejects above one", () => {
    expect(createPoolBody.safeParse({ ...base, quotaSoftLimit: 1.01 }).success).toBe(false)
  })

  test("accepts absent (column default 0.80 applies)", () => {
    expect(createPoolBody.safeParse(base).success).toBe(true)
  })

  test("accepts null on update (reset to default)", () => {
    expect(updatePoolBody.safeParse({ quotaSoftLimit: null }).success).toBe(true)
  })
})
