import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  inPlaceReason,
  NO_ATTEMPTS,
  noteModelThrottle,
  planNextAttempt,
  recordAttempt,
} from "../../../src/services/routing"
import { account, candidates } from "./fixtures"

/**
 * A `429` that held one model off its only account (prod 2026-11-28: a free NVIDIA key, one account
 * serving the model, 480 of 1,430 `/v1/messages` in three hours answered `429` within ~350 ms). The
 * hold lapses in seconds, and no other account serves the name, so the honest service is to wait it
 * out and ask the same account again before any byte is on the wire, inside
 * `ROUTING_MODEL_THROTTLE_WAIT_MS`. Pure: the planner and its progress folds.
 */

const throttled: AttemptFailure = { kind: "rate-limited", status: 429, message: "vendor:http-429" }
const OPTIONS = { modelThrottleWaitMs: 30_000 }

function afterThrottle(delayMs: number) {
  return noteModelThrottle(recordAttempt(NO_ATTEMPTS, "a"), "a", delayMs)
}

describe("a model throttle on the last candidate, failure case first", () => {
  test("the same account is asked again once its hold lapses, with the hold as the wait", () => {
    const decision = planNextAttempt(
      candidates(account("a")),
      afterThrottle(2_000),
      throttled,
      OPTIONS,
    )
    expect(decision.action).toBe("retry-in-place")
    if (decision.action !== "retry-in-place") return
    expect(decision.candidate.account.id).toBe("a")
    expect(decision.delayMs).toBe(2_000)
    expect(inPlaceReason(decision)).toBe("throttle")
  })

  test("another candidate is asked first, with no wait", () => {
    const decision = planNextAttempt(
      candidates(account("a"), account("b")),
      afterThrottle(2_000),
      throttled,
      OPTIONS,
    )
    expect(decision.action).toBe("attempt")
    if (decision.action === "attempt") expect(decision.candidate.account.id).toBe("b")
  })

  test("the waits share one budget per chain, and a hold past what is left is not waited", () => {
    let progress = afterThrottle(20_000)
    const first = planNextAttempt(candidates(account("a")), progress, throttled, OPTIONS)
    expect(first.action).toBe("retry-in-place")
    progress = recordAttempt(progress, "a", inPlaceReason(first))
    progress = noteModelThrottle(progress, "a", 15_000)
    const second = planNextAttempt(candidates(account("a")), progress, throttled, OPTIONS)
    expect(second).toEqual({ action: "stop", reason: "attempts-exhausted" })
  })

  test("no budget, no wait: the 429 is the answer at once", () => {
    const decision = planNextAttempt(candidates(account("a")), afterThrottle(1_000), throttled, {})
    expect(decision).toEqual({ action: "stop", reason: "attempts-exhausted" })
  })

  test("any other failure from that account forgets the throttle", () => {
    const progress = noteModelThrottle(afterThrottle(1_000), "a", null)
    expect(progress.throttled).toBeUndefined()
  })
})
