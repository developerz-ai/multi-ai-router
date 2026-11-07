import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import {
  type AttemptFailure,
  type BreakerState,
  HEALTHY,
  NO_ATTEMPTS,
  noteOverload,
  planNextAttempt,
  recordAttempt,
  recordFailure,
} from "../../../src/services/routing"
import { response } from "../providers/fixtures"
import { account, candidates } from "./fixtures"

/**
 * `overloaded`: the provider's shared backend is busy (prod 2026-11-07, OpenCode Go's `[overloaded]`
 * `429`, 199 router-made `429`s while no seat was out of anything). Pure: planner, breaker, rules.
 */

const GO_OVERLOADED = {
  type: "error",
  error: {
    type: "rate_limit_error",
    message: "Upstream request failed: [overloaded] the server is overloaded; retry shortly",
  },
}

const overloaded: AttemptFailure = { kind: "overloaded", status: 429, message: "overloaded" }
const NOW = new Date("2026-11-07T01:00:00.000Z")

describe("classification, failure case first", () => {
  test("Go's [overloaded] 429 is overloaded, never a rate limit", () => {
    const result = httpDriver("opencode-go")?.classifyFailure(
      response(429, { body: GO_OVERLOADED }),
    )
    expect(result?.kind).toBe("overloaded")
    expect(result?.signal).toBe("opencode-go:overloaded")
    expect(result?.retryable).toBe(true)
  })

  test("Go's own seat limit stays a rate limit", () => {
    const body = {
      type: "error",
      error: { type: "rate_limit_error", message: "Go usage limit exceeded" },
    }
    expect(httpDriver("opencode-go")?.classifyFailure(response(429, { body }))?.kind).toBe(
      "rate-limited",
    )
  })

  test("Anthropic's overloaded_error is overloaded; api_error stays a server error", () => {
    const anthropic = httpDriver("anthropic-api")
    const body = (type: string) => ({ type: "error", error: { type, message: "x" } })
    expect(
      anthropic?.classifyFailure(response(529, { body: body("overloaded_error") }))?.kind,
    ).toBe("overloaded")
    expect(anthropic?.classifyFailure(response(500, { body: body("api_error") }))?.kind).toBe(
      "server-error",
    )
  })
})

describe("the breaker never strikes for an overloaded backend", () => {
  test("any number of them leaves a healthy account healthy", () => {
    let state: BreakerState = HEALTHY
    for (let i = 0; i < 10; i++) state = recordFailure(state, overloaded, NOW)
    expect(state).toBe(HEALTHY)
  })
})

describe("planning after overloaded", () => {
  const chain = candidates(account("a"), account("b"))

  test("the next account is asked first, with no wait", () => {
    const decision = planNextAttempt(chain, recordAttempt(NO_ATTEMPTS, "a"), overloaded, {
      overloadRetries: 2,
      overloadRetryBaseMs: 1_000,
    })
    expect(decision).toMatchObject({ action: "attempt" })
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("b")
  })

  test("every account asked: the last again after a doubling wait, then stop", () => {
    const options = { overloadRetries: 2, overloadRetryBaseMs: 1_000 }
    let progress = recordAttempt(recordAttempt(NO_ATTEMPTS, "a"), "b")
    const first = planNextAttempt(chain, progress, overloaded, options)
    expect(first).toMatchObject({ action: "retry-in-place", delayMs: 1_000 })
    progress = recordAttempt(progress, "b", true)
    const second = planNextAttempt(chain, progress, overloaded, options)
    expect(second).toMatchObject({ action: "retry-in-place", delayMs: 2_000 })
    progress = recordAttempt(progress, "b", true)
    expect(planNextAttempt(chain, progress, overloaded, options)).toMatchObject({ action: "stop" })
  })

  test("no retries configured: stops once every account was asked", () => {
    const progress = recordAttempt(recordAttempt(NO_ATTEMPTS, "a"), "b")
    expect(planNextAttempt(chain, progress, overloaded, {})).toMatchObject({ action: "stop" })
  })

  test("a rate limit is never retried in place", () => {
    const progress = recordAttempt(recordAttempt(NO_ATTEMPTS, "a"), "b")
    const limited: AttemptFailure = { kind: "rate-limited", message: "429" }
    expect(
      planNextAttempt(chain, progress, limited, { overloadRetries: 2, overloadRetryBaseMs: 1 }),
    ).toMatchObject({ action: "stop" })
  })

  // Post-merge review of #361: whether the busy seat was waited out hung on candidate order. Seat
  // `a` overloaded, seat `b` then answered its own real limit: the chain stopped and the client
  // heard `b`'s `429 quota_exhausted` while `a`, never cooled, would have served after the wait.
  test("an overloaded seat earlier in the chain is waited out even when the last said rate-limited", () => {
    const limited: AttemptFailure = { kind: "rate-limited", message: "Go usage limit exceeded" }
    let progress = noteOverload(recordAttempt(NO_ATTEMPTS, "a"), "a", "overloaded")
    progress = noteOverload(recordAttempt(progress, "b"), "b", "rate-limited")
    const decision = planNextAttempt(chain, progress, limited, {
      overloadRetries: 1,
      overloadRetryBaseMs: 1_000,
    })
    expect(decision).toMatchObject({ action: "retry-in-place", delayMs: 1_000 })
    expect(decision.action === "retry-in-place" && decision.candidate.account.id).toBe("a")
  })

  test("the waited-out seat answering anything but overloaded is not asked again", () => {
    const limited: AttemptFailure = { kind: "rate-limited", message: "Go usage limit exceeded" }
    let progress = noteOverload(recordAttempt(NO_ATTEMPTS, "a"), "a", "overloaded")
    progress = noteOverload(recordAttempt(progress, "b"), "b", "rate-limited")
    progress = noteOverload(recordAttempt(progress, "a", true), "a", "rate-limited")
    expect(
      planNextAttempt(chain, progress, limited, { overloadRetries: 2, overloadRetryBaseMs: 1 }),
    ).toMatchObject({ action: "stop" })
  })
})
