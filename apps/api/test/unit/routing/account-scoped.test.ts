import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  HEALTHY,
  NO_ATTEMPTS,
  noteOverload,
  noteProviderScoped,
  planNextAttempt,
  recordAttempt,
  recordFailure,
} from "../../../src/services/routing"
import { account, candidates, NOW } from "./fixtures"

// Prod, 2026-11-24 04:06Z: `openrouter-dz-coding-30d` answered `404 No endpoints found for the
// request with quantization: fp8,bf16` three times. That is the account's own provider preferences
// leaving no endpoint; an OpenRouter sibling without the filter serves the same body. As a plain
// `client-error` it ended the chain on the first account.
const filtered: AttemptFailure = {
  kind: "client-error",
  status: 404,
  message: "openrouter:request-filtered",
  accountScoped: true,
}
const openrouter = (id: string) => account(id, { provider: "openrouter" })
const chain = candidates(
  openrouter("or1"),
  openrouter("or2"),
  account("nv", { provider: "nvidia" }),
)

describe("a 4xx about one account's own settings", () => {
  test("walks to the next account, the same provider's included", () => {
    const decision = planNextAttempt(chain, recordAttempt(NO_ATTEMPTS, "or1"), filtered)
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("or2")
  })

  test("is not folded as a provider refusal, so it skips nobody", () => {
    const progress = noteProviderScoped(recordAttempt(NO_ATTEMPTS, "or1"), "openrouter", filtered)
    expect(progress.refusedProviders).toBeUndefined()
  })

  test("with no account left the chain stops for the upstream's own 4xx to be relayed", () => {
    const two = candidates(openrouter("or1"), openrouter("or2"))
    const progress = recordAttempt(recordAttempt(NO_ATTEMPTS, "or1"), "or2")
    expect(planNextAttempt(two, progress, filtered)).toEqual({
      action: "stop",
      reason: "provider-wall",
    })
    const lone = candidates(openrouter("or1"))
    expect(planNextAttempt(lone, recordAttempt(NO_ATTEMPTS, "or1"), filtered)).toEqual({
      action: "stop",
      reason: "provider-wall",
    })
  })

  test("an account that said overloaded earlier is still asked again", () => {
    const busy: AttemptFailure = { kind: "overloaded", status: 529, message: "busy" }
    const two = candidates(account("nv", { provider: "nvidia" }), openrouter("or1"))
    let progress = noteOverload(recordAttempt(NO_ATTEMPTS, "nv"), "nv", busy.kind)
    progress = recordAttempt(progress, "or1")
    const decision = planNextAttempt(two, progress, filtered, {
      overloadRetries: 1,
      overloadRetryBaseMs: 500,
    })
    expect(decision.action === "retry-in-place" && decision.candidate.account.id).toBe("nv")
  })

  test("never strikes the breaker, and never outlives bytes on the wire", () => {
    expect(recordFailure(HEALTHY, filtered, NOW)).toBe(HEALTHY)
    const streamed = { ...recordAttempt(NO_ATTEMPTS, "or1"), bytesStreamed: true }
    expect(planNextAttempt(chain, streamed, filtered)).toEqual({
      action: "stop",
      reason: "bytes-streamed",
    })
  })

  test("the operator's attempt ceiling still bounds the walk", () => {
    const decision = planNextAttempt(chain, recordAttempt(NO_ATTEMPTS, "or1"), filtered, {
      maxAttempts: 1,
    })
    expect(decision).toEqual({ action: "stop", reason: "provider-wall" })
  })
})
