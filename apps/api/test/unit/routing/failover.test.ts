/**
 * Bounded failover, and the rule that dominates it: once bytes are on the wire, nothing is
 * retried.
 */

import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  classifyStatus,
  type FailoverProgress,
  type FailureKind,
  isRetryable,
  markStreamed,
  maxAttempts,
  NO_ATTEMPTS,
  planNextAttempt,
  recordAttempt,
} from "../../../src/services/routing"
import { account, candidates, subscription } from "./fixtures"

const chain = candidates(account("a"), account("b"), account("c"), account("d"))

const failure = (kind: FailureKind, overrides: Partial<AttemptFailure> = {}): AttemptFailure => ({
  kind,
  message: kind,
  ...overrides,
})

const after = (...accountIds: readonly string[]): FailoverProgress =>
  accountIds.reduce<FailoverProgress>(
    (progress, accountId) => recordAttempt(progress, accountId),
    NO_ATTEMPTS,
  )

describe("classification", () => {
  const cases: readonly [number, FailureKind, boolean][] = [
    [429, "rate-limited", true],
    [402, "credits-exhausted", true],
    [500, "server-error", true],
    [503, "server-error", true],
    [401, "auth", false],
    [403, "auth", false],
    [400, "client-error", false],
    [422, "client-error", false],
  ]

  test.each(cases)("%d is %s, retryable=%p", (status, kind, retryable) => {
    expect(classifyStatus(status)).toBe(kind)
    expect(isRetryable(kind)).toBe(retryable)
  })

  test("a success is not a failure at all", () => {
    expect(classifyStatus(200)).toBeNull()
  })

  test("a driver-detected out-of-credits body outranks the status", () => {
    expect(classifyStatus(400, { outOfCredits: true })).toBe("credits-exhausted")
  })

  test("connection failures and timeouts are retryable without a status", () => {
    expect(isRetryable("connection")).toBe(true)
    expect(isRetryable("timeout")).toBe(true)
  })
})

describe("ordering and bounds", () => {
  test("the first attempt is the head of the ordered list", () => {
    const decision = planNextAttempt(chain, NO_ATTEMPTS, null)
    expect(decision).toMatchObject({ action: "attempt", attempt: 1 })
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("a")
  })

  test("a retryable failure walks to the next candidate, in order", () => {
    const decision = planNextAttempt(chain, after("a"), failure("rate-limited"))
    expect(decision).toMatchObject({ action: "attempt", attempt: 2 })
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("b")
  })

  test("each attempt is a distinct account", () => {
    const decision = planNextAttempt(chain, after("a", "b"), failure("server-error"), {
      maxAttempts: 4,
    })
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("c")
  })

  test("attempts are bounded well under the candidate count", () => {
    expect(maxAttempts(chain)).toBe(3)
    expect(planNextAttempt(chain, after("a", "b", "c"), failure("server-error"))).toEqual({
      action: "stop",
      reason: "attempts-exhausted",
    })
  })

  test("the cap never exceeds the number of candidates", () => {
    expect(maxAttempts(chain.slice(0, 2), { maxAttempts: 10 })).toBe(2)
  })

  test("a short pool stops when its accounts run out, not when the configured cap does", () => {
    const two = chain.slice(0, 2)
    expect(
      planNextAttempt(two, after("a", "b"), failure("rate-limited"), { maxAttempts: 10 }),
    ).toEqual({ action: "stop", reason: "attempts-exhausted" })
  })

  test("an empty candidate list has nothing to attempt", () => {
    expect(planNextAttempt([], NO_ATTEMPTS, null)).toEqual({
      action: "stop",
      reason: "candidates-exhausted",
    })
  })
})

describe("what is not retried", () => {
  test.each(["auth", "client-error"] as const)("%s stops the chain", (kind) => {
    expect(planNextAttempt(chain, after("a"), failure(kind))).toEqual({
      action: "stop",
      reason: "not-retryable",
    })
  })

  test("once bytes have been streamed the request fails honestly", () => {
    const streamed = markStreamed(after("a"))
    expect(planNextAttempt(chain, streamed, failure("server-error"))).toEqual({
      action: "stop",
      reason: "bytes-streamed",
    })
  })

  test("the streaming rule outranks every retryable cause", () => {
    const streamed = markStreamed(after("a"))
    for (const kind of ["rate-limited", "credits-exhausted", "connection", "timeout"] as const) {
      expect(planNextAttempt(chain, streamed, failure(kind))).toEqual({
        action: "stop",
        reason: "bytes-streamed",
      })
    }
  })
})

describe("the SDK path is not the HTTP path", () => {
  const sdkChain = candidates(subscription("a"), subscription("b"))

  test("moving away from a bound account invalidates the mapping and restarts the session", () => {
    const decision = planNextAttempt(sdkChain, after("a"), failure("rate-limited"), {
      boundAccountId: "a",
    })
    expect(decision).toMatchObject({
      action: "attempt",
      invalidateBinding: true,
      sessionRestart: true,
    })
  })

  test("on the HTTP path the hop is transparent — no restart to surface", () => {
    const decision = planNextAttempt(chain, after("a"), failure("rate-limited"), {
      boundAccountId: "a",
    })
    expect(decision).toMatchObject({ invalidateBinding: true, sessionRestart: false })
  })

  test("an unbound session invalidates nothing", () => {
    expect(planNextAttempt(chain, after("a"), failure("rate-limited"))).toMatchObject({
      invalidateBinding: false,
      sessionRestart: false,
    })
  })

  test("a stale session replays once in place, on the same account", () => {
    const decision = planNextAttempt(sdkChain, after("a"), failure("stale-session"))
    expect(decision).toMatchObject({ action: "retry-in-place" })
    expect(decision.action === "retry-in-place" && decision.candidate.account.id).toBe("a")
  })

  test("the in-place replay is granted exactly once", () => {
    const replayed = recordAttempt(after("a"), "a", true)
    expect(planNextAttempt(sdkChain, replayed, failure("stale-session"))).toEqual({
      action: "stop",
      reason: "not-retryable",
    })
  })

  test("an in-place replay does not consume an attempt slot", () => {
    const replayed = recordAttempt(after("a"), "a", true)
    expect(replayed.attemptedAccountIds).toEqual(["a"])
    expect(replayed.inPlaceRetries).toBe(1)
  })
})

test("progress is immutable — nothing here mutates its input", () => {
  const first = recordAttempt(NO_ATTEMPTS, "a")
  expect(NO_ATTEMPTS.attemptedAccountIds).toEqual([])
  expect(first.attemptedAccountIds).toEqual(["a"])
  expect(markStreamed(first).bytesStreamed).toBe(true)
  expect(first.bytesStreamed).toBe(false)
})
