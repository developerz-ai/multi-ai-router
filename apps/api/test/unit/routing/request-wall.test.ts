import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  type FailoverProgress,
  HEALTHY,
  NO_ATTEMPTS,
  noteRequestAttributable,
  planNextAttempt,
  recordAttempt,
  recordFailure,
} from "../../../src/services/routing"
import { account, candidates, NOW } from "./fixtures"

// Plan 101, 05.14 (ruled): an Agent-SDK refusal provoked by the request's own content
// (`claude-sdk:extra-usage-gated`) fails over with no cooldown and no breaker strike; a second such
// answer in one chain ends it as a request wall, never a router 429.
const gated: AttemptFailure = {
  kind: "rate-limited",
  status: 429,
  message: "claude-sdk:extra-usage-gated",
  requestAttributable: true,
}
const chain = candidates(account("a"), account("b"), account("c"))

function answered(...ids: readonly string[]): FailoverProgress {
  return ids.reduce(
    (progress, id) => noteRequestAttributable(recordAttempt(progress, id), gated),
    NO_ATTEMPTS,
  )
}

describe("a request-attributable refusal", () => {
  test("never strikes the breaker, however often it repeats", () => {
    let state = HEALTHY
    for (let i = 0; i < 10; i++) state = recordFailure(state, gated, NOW)
    expect(state).toBe(HEALTHY)
  })

  test("the first one fails over to the next account", () => {
    const decision = planNextAttempt(chain, answered("a"), gated)
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("b")
  })

  test("the second one in a chain ends it as a request wall", () => {
    expect(planNextAttempt(chain, answered("a", "b"), gated)).toEqual({
      action: "stop",
      reason: "request-wall",
    })
  })

  test("the threshold is an option", () => {
    const decision = planNextAttempt(chain, answered("a", "b"), gated, { requestWallAfter: 3 })
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("c")
  })

  test("an ordinary failure folds nothing into the count", () => {
    const progress = noteRequestAttributable(NO_ATTEMPTS, { requestAttributable: undefined })
    expect(progress).toBe(NO_ATTEMPTS)
  })
})
