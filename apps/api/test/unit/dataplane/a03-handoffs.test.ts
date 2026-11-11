import { describe, expect, test } from "bun:test"
import { buildSnapshot, createHealthStore } from "../../../src/services/dataplane"
import { toAttemptFailure } from "../../../src/services/dataplane/attempt-failure"
import { finishChain } from "../../../src/services/dataplane/chain-finish"
import { account, catalog, NOW } from "./fixtures"

describe("reported resets are bounded by the configured ceiling (04.2)", () => {
  test("a 30-day provider reset cools the account no longer than the ceiling", () => {
    const health = createHealthStore({ jitter: () => 0, maxReportedResetSeconds: 3_600 })
    health.recordFailure(
      "a",
      {
        kind: "rate-limited",
        resetsAt: new Date(NOW.getTime() + 30 * 86_400_000),
        resetSource: "provider-reported",
        message: "limited",
      },
      NOW,
    )
    const until = health.stateOf("a").breaker.cooldownUntil
    expect(until).toBeDefined()
    expect((until?.getTime() ?? 0) - NOW.getTime()).toBeLessThanOrEqual(3_600_000)
  })
})

describe("request-attributable failures stop as a request wall (05.14)", () => {
  test("the classification's flag reaches the attempt failure", () => {
    const failure = toAttemptFailure(
      400,
      {
        kind: "invalid-request",
        status: 400,
        retryable: false,
        signal: "claude-sdk:extra-usage-gated",
        rateLimit: null,
        requestAttributable: true,
      },
      null,
    )
    expect(failure.requestAttributable).toBe(true)
  })

  test("a chain stopped on a request wall answers the request's own 400, never a 429", () => {
    expect(() =>
      finishChain(null, { kind: "rate-limited", message: "gated" }, () => {}, undefined, {
        requestWall: true,
      }),
    ).toThrow(expect.objectContaining({ status: 400 }))
  })
})

describe("a model the account refused stays off it for the TTL (10.16)", () => {
  test("refused models overlay onto the snapshot and are absent without a TTL", () => {
    const health = createHealthStore({ modelRefusalTtlMs: 60_000 })
    health.refuseModel("a", "glm-9", NOW)
    const [view] = buildSnapshot(catalog([account("a")]), health, NOW).accounts
    expect(view?.refusedModels?.get("glm-9")?.getTime()).toBe(NOW.getTime() + 60_000)

    const off = createHealthStore()
    off.refuseModel("a", "glm-9", NOW)
    expect(off.stateOf("a").refusedModels).toBeUndefined()
  })
})
