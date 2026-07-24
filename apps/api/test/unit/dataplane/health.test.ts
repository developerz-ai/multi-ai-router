import { describe, expect, test } from "bun:test"
import type { RateLimitSignal } from "../../../src/providers"
import { buildSnapshot, createHealthStore, overlayHealth } from "../../../src/services/dataplane"
import { account, catalog, NOW } from "./fixtures"

/**
 * The health snapshot the pure selection functions read.
 *
 * The invariant that matters most: `cooling_down` and `exhausted` are never conflated. One carries
 * a reset instant a clock will pass; the other carries none, by definition, so nothing can retry it
 * on a timer.
 */

function signal(overrides: Partial<RateLimitSignal> = {}): RateLimitSignal {
  return { limited: false, resetSource: "unknown", windows: [], ...overrides }
}

describe("health store", () => {
  test("a fresh account is healthy and in no cooldown", () => {
    const store = createHealthStore()
    expect(store.stateOf("a").breaker.status).toBe("active")
  })

  test("a rate limit cools the account down until its reported reset", () => {
    const store = createHealthStore()
    const resetsAt = new Date(NOW.getTime() + 60_000)

    store.recordFailure(
      "a",
      { kind: "rate-limited", resetsAt, resetSource: "provider-reported", message: "429" },
      NOW,
    )

    const state = store.stateOf("a")
    expect(state.breaker.status).toBe("cooling_down")
    expect(state.breaker.cooldownUntil).toEqual(resetsAt)
    expect(state.breaker.cooldownSource).toBe("provider-reported")
  })

  test("out of credits is exhausted, with no reset — no timer can clear it", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    const state = store.stateOf("a")
    expect(state.breaker.status).toBe("exhausted")
    expect(state.breaker.cooldownUntil).toBeUndefined()
  })

  test("an auth failure needs a human: reauth for OAuth, disabled for a key", () => {
    const store = createHealthStore()
    store.recordFailure("oauth", { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })
    store.recordFailure("key", { kind: "auth", message: "401" }, NOW, { authKind: "api-key" })

    expect(store.stateOf("oauth").breaker.status).toBe("needs_reauth")
    expect(store.stateOf("key").breaker.status).toBe("disabled")
  })

  test("a reported limit on an otherwise fine response still cools the account down", () => {
    const store = createHealthStore()
    const resetsAt = new Date(NOW.getTime() + 30_000)

    store.applyRateLimit(
      "a",
      signal({ limited: true, resetsAt, resetSource: "provider-reported" }),
      NOW,
    )

    expect(store.stateOf("a").breaker.status).toBe("cooling_down")
  })

  test("keeps the limiter windows the provider reported, under its own names", () => {
    const store = createHealthStore()
    store.applyRateLimit(
      "a",
      signal({
        windows: [
          {
            limiter: "input-tokens",
            limit: 100,
            remaining: 40,
            utilization: 0.6,
            utilizationSource: "continuous",
            resetSource: "unknown",
          },
        ],
      }),
      NOW,
    )

    expect(store.stateOf("a").limiterWindows[0]?.limiter).toBe("input-tokens")
    expect(store.stateOf("a").lastSignalAt).toEqual(NOW)
  })

  test("a success clears the streak and returns the account to active", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "server-error", message: "500" }, NOW)
    store.recordSuccess("a")

    expect(store.stateOf("a").breaker).toMatchObject({ status: "active", consecutiveFailures: 0 })
  })

  test("in-flight and recent tokens track what least-used ranks on", () => {
    const store = createHealthStore()
    store.beginAttempt("a")
    expect(store.stateOf("a").inFlight).toBe(1)

    store.endAttempt("a", 250)
    expect(store.stateOf("a")).toMatchObject({ inFlight: 0, recentTokens: 250 })
  })
})

describe("snapshot", () => {
  test("overlays live breaker state onto the account's routing view", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    const snapshot = buildSnapshot(catalog([account("a")]), store, NOW)

    expect(snapshot.accounts[0]?.status).toBe("exhausted")
  })

  test("never promotes an account the operator disabled", () => {
    const disabled = account("a", { snapshot: { status: "disabled" } })
    const overlaid = overlayHealth(disabled.snapshot, createHealthStore().stateOf("a"))
    expect(overlaid.status).toBe("disabled")
  })
})
