import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  type FailoverProgress,
  HEALTHY,
  NO_ATTEMPTS,
  noteOverload,
  noteProviderScoped,
  planNextAttempt,
  recordAttempt,
  recordFailure,
} from "../../../src/services/routing"
import { account, candidates, NOW } from "./fixtures"

// Prod, 2026-11-23: 31 `400`s on `gemini-free-1` in 5.4 h, each ending its chain as a `client-error`
// with seven accounts of other providers behind it. For the ones about Gemini's own wire (a tool
// call another vendor's model made carries no thought signature) another vendor serves the body as
// it stands, and `gemini-free-2` would only repeat the refusal.
const wire: AttemptFailure = {
  kind: "client-error",
  status: 400,
  message: "gemini:thought-signature-missing",
  providerScoped: true,
}
const gemini = (id: string) => account(id, { provider: "gemini" })
const chain = candidates(
  gemini("g1"),
  gemini("g2"),
  account("or", { provider: "openrouter" }),
  account("nv", { provider: "nvidia" }),
)

function refusedOn(ordered: typeof chain, ...ids: readonly string[]): FailoverProgress {
  return ids.reduce((progress, id) => {
    const provider = ordered.find((entry) => entry.account.id === id)?.account.provider ?? "?"
    return noteProviderScoped(recordAttempt(progress, id), provider, wire)
  }, NO_ATTEMPTS)
}

describe("a provider-scoped 4xx", () => {
  test("skips the same provider's remaining accounts and goes to the next provider", () => {
    const decision = planNextAttempt(chain, refusedOn(chain, "g1"), wire)
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("or")
  })

  test("the provider stays skipped when a later account fails for its own reason", () => {
    const limited: AttemptFailure = { kind: "rate-limited", status: 429, message: "429" }
    const progress = recordAttempt(refusedOn(chain, "g1"), "or")
    const decision = planNextAttempt(chain, progress, limited)
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("nv")
  })

  test("with no other provider left the chain stops as the provider wall", () => {
    const only = candidates(gemini("g1"), gemini("g2"))
    expect(planNextAttempt(only, refusedOn(only, "g1"), wire)).toEqual({
      action: "stop",
      reason: "provider-wall",
    })
    const lone = candidates(gemini("g1"))
    expect(planNextAttempt(lone, refusedOn(lone, "g1"), wire)).toEqual({
      action: "stop",
      reason: "provider-wall",
    })
  })

  test("two providers each refusing their own wire end as the wall once none is left", () => {
    const two = candidates(gemini("g1"), account("or", { provider: "openrouter" }))
    expect(planNextAttempt(two, refusedOn(two, "g1", "or"), wire)).toEqual({
      action: "stop",
      reason: "provider-wall",
    })
  })

  test("an account that said overloaded earlier is still asked again", () => {
    const busy: AttemptFailure = { kind: "overloaded", status: 529, message: "busy" }
    const two = candidates(account("or", { provider: "openrouter" }), gemini("g1"))
    let progress = noteOverload(recordAttempt(NO_ATTEMPTS, "or"), "or", busy.kind)
    progress = noteProviderScoped(recordAttempt(progress, "g1"), "gemini", wire)
    const decision = planNextAttempt(two, progress, wire, {
      overloadRetries: 1,
      overloadRetryBaseMs: 500,
    })
    expect(decision).toMatchObject({ action: "retry-in-place", delayMs: 500 })
    expect(decision.action === "retry-in-place" && decision.candidate.account.id).toBe("or")
  })

  test("never strikes the breaker", () => {
    expect(recordFailure(HEALTHY, wire, NOW)).toBe(HEALTHY)
  })

  test("nothing is retried once bytes are on the wire", () => {
    const streamed = { ...refusedOn(chain, "g1"), bytesStreamed: true }
    expect(planNextAttempt(chain, streamed, wire)).toEqual({
      action: "stop",
      reason: "bytes-streamed",
    })
  })

  test("an unflagged client error still stops at once", () => {
    const bad: AttemptFailure = { kind: "client-error", status: 400, message: "bad request" }
    expect(planNextAttempt(chain, recordAttempt(NO_ATTEMPTS, "g1"), bad)).toEqual({
      action: "stop",
      reason: "not-retryable",
    })
  })

  test("the fold is idempotent and ignores an unflagged failure", () => {
    const once = noteProviderScoped(NO_ATTEMPTS, "gemini", wire)
    expect(noteProviderScoped(once, "gemini", wire)).toBe(once)
    expect(noteProviderScoped(NO_ATTEMPTS, "gemini", { providerScoped: false })).toBe(NO_ATTEMPTS)
  })
})
