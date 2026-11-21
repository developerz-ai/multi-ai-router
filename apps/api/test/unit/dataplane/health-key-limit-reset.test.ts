import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { createHealthStore } from "../../../src/services/dataplane"
import type { AttemptFailure } from "../../../src/services/routing"

/**
 * A metered OpenRouter key that hits its own spend cap. Prod fingerprint: `openrouter-glm53-fallback`
 * went `exhausted` on 2026-10-08 and stayed there — a key cap reads as `402` / `403 Key limit
 * exceeded`, `credits-exhausted`, which no clock clears. With the key's own reading held
 * (`GET /api/v1/key`: `limit_reset: daily`, `limit_remaining: 0`), the same refusal is a window
 * with a known end: the account cools until the next 00:00 UTC and is eligible again then.
 */

const READ_AT = new Date("2026-11-14T18:30:00.000Z")
const REFUSED_AT = new Date("2026-11-14T18:31:00.000Z")
const MIDNIGHT = new Date("2026-11-15T00:00:00.000Z")
const FRESH = 30 * 60_000

const keyLimit: AttemptFailure = {
  kind: "credits-exhausted",
  status: 402,
  message: "Key limit exceeded",
}

function reading(data: Record<string, unknown>) {
  return httpDriver("openrouter")?.quotaRead?.read({ data }, READ_AT) ?? null
}

function store() {
  return createHealthStore({ planReadingMaxAgeMs: FRESH })
}

describe("an openrouter key cap with a reset cools until that reset, failures first", () => {
  test("with no reading held, a key-limit refusal is exhausted as today", () => {
    const health = store()
    health.recordFailure("or", keyLimit, REFUSED_AT)
    expect(health.stateOf("or").breaker.status).toBe("exhausted")
  })

  test("a cap that never resets stays exhausted: it needs a human", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: null, limit_remaining: 0 }),
      READ_AT,
    )
    health.recordFailure("or", keyLimit, REFUSED_AT)
    expect(health.stateOf("or").breaker.status).toBe("exhausted")
  })

  test("a key with headroom left is not explained by its cap: a 402 there is a dead balance", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 4 }),
      READ_AT,
    )
    health.recordFailure("or", keyLimit, REFUSED_AT)
    expect(health.stateOf("or").breaker.status).toBe("exhausted")
  })

  test("a stale reading lends nothing", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      READ_AT,
    )
    health.recordFailure("or", keyLimit, new Date(READ_AT.getTime() + FRESH))
    expect(health.stateOf("or").breaker.status).toBe("exhausted")
  })

  test("a spent daily cap cools the account until 00:00 UTC, provider-reported", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      READ_AT,
    )
    health.recordFailure("or", keyLimit, REFUSED_AT)
    const { breaker } = health.stateOf("or")
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).toEqual(MIDNIGHT)
    expect(breaker.cooldownSource).toBe("provider-reported")
  })

  test("a reset the refusal states itself is preferred over the computed boundary", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      READ_AT,
    )
    const stated = new Date("2026-11-14T20:00:00.000Z")
    health.recordFailure("or", { ...keyLimit, resetsAt: stated }, REFUSED_AT)
    expect(health.stateOf("or").breaker.cooldownUntil).toEqual(stated)
  })

  test("keyCapResetAt exposes the same verified reset the breaker uses", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      READ_AT,
    )
    expect(health.keyCapResetAt("or", REFUSED_AT)).toEqual(MIDNIGHT)
  })

  test("keyCapResetAt invents no instant for headroom, no reset, a stale or past reading", () => {
    // A fresh store per case: quota readings merge, so an earlier window must not lend a reset to
    // a later reading that has none.
    expect(store().keyCapResetAt("or", REFUSED_AT)).toBeNull()

    const headroom = store()
    headroom.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 4 }),
      READ_AT,
    )
    expect(headroom.keyCapResetAt("or", REFUSED_AT)).toBeNull()

    const noReset = store()
    noReset.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: null, limit_remaining: 0 }),
      READ_AT,
    )
    expect(noReset.keyCapResetAt("or", REFUSED_AT)).toBeNull()

    const spent = store()
    spent.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      READ_AT,
    )
    expect(spent.keyCapResetAt("or", new Date(READ_AT.getTime() + FRESH))).toBeNull()
    expect(spent.keyCapResetAt("or", MIDNIGHT)).toBeNull()
  })

  test("the 403 key-limit-window form, an estimated hourly re-test, also waits for the boundary", () => {
    const health = store()
    health.applyRateLimit(
      "or",
      reading({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      READ_AT,
    )
    const window: AttemptFailure = {
      kind: "rate-limited",
      status: 403,
      retryAfterSeconds: 3600,
      resetSource: "estimated",
      message: "Key limit exceeded (daily limit)",
    }
    health.recordFailure("or", window, REFUSED_AT)
    expect(health.stateOf("or").breaker.cooldownUntil).toEqual(MIDNIGHT)
  })
})
