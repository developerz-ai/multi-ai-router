import { describe, expect, test } from "bun:test"
import { usageOutcomeFault } from "@multi-ai-router/core"
import {
  type AttemptRecordInput,
  attemptRecord,
  failureOutcome,
} from "../../../src/services/dataplane/records"
import { RETRYABLE_FAILURE_KINDS } from "../../../src/services/routing"

/**
 * The mapping from "how the upstream failed" to "what the usage view says happened". Pure, so it
 * needs no server, no clock, and no mock.
 */

const AT = new Date("2026-01-01T12:00:00.000Z")

function input(overrides: Partial<AttemptRecordInput> = {}): AttemptRecordInput {
  return {
    correlationId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    apiKeyId: "key-1",
    accountId: "acct-1",
    provider: "anthropic-api",
    sessionKey: "session-1",
    model: "sonnet",
    upstreamModel: "glm-4.7",
    timing: { startedAt: AT, finishedAt: AT, latencyMs: 120, totalMs: 124, upstreamMs: 120 },
    outcome: "success",
    streamed: true,
    httpStatus: 200,
    errorClass: null,
    ...overrides,
  }
}

describe("failure kind to usage outcome", () => {
  test("a 5xx, a refused connection and a stale session are the upstream's fault", () => {
    // All three used to report as `no_healthy_account`, which reads as "the operator has no
    // capacity" when the truth is "the provider had a bad minute".
    for (const kind of ["server-error", "connection", "stale-session"] as const) {
      expect(failureOutcome(kind)).toBe("upstream_error")
      expect(usageOutcomeFault(failureOutcome(kind))).toBe("upstream")
    }
  })

  test("a malformed request is the caller's fault", () => {
    expect(failureOutcome("client-error")).toBe("client_error")
    expect(usageOutcomeFault(failureOutcome("client-error"))).toBe("client")
  })

  test("rate-limited and out-of-credits stay distinct all the way into the row", () => {
    expect(failureOutcome("rate-limited")).toBe("quota_exhausted")
    expect(failureOutcome("credits-exhausted")).toBe("credits_exhausted")
  })

  test("a timeout is a timeout and an auth rejection names the account's credential", () => {
    expect(failureOutcome("timeout")).toBe("upstream_timeout")
    expect(failureOutcome("auth")).toBe("upstream_auth_failed")
  })

  test("no failure kind reports as a router fault — the router did not fail, an upstream did", () => {
    for (const kind of RETRYABLE_FAILURE_KINDS) {
      expect(usageOutcomeFault(failureOutcome(kind))).not.toBe("router")
    }
  })
})

describe("attempt record", () => {
  test("carries both model names, so an alias is visible after the fact", () => {
    const record = attemptRecord(input())
    expect(record.model).toBe("sonnet")
    expect(record.upstreamModel).toBe("glm-4.7")
  })

  test("an unmeasured first byte is null, not zero", () => {
    expect(attemptRecord(input()).ttfbMs).toBeNull()
    expect(attemptRecord(input({ timing: { ...input().timing, ttfbMs: 37.4 } })).ttfbMs).toBe(37)
  })

  test("attribution a preflight failure does not have is null, not invented", () => {
    const record = attemptRecord(input({ accountId: null, provider: null }))
    expect(record.poolId).toBeNull()
    expect(record.egressMode).toBeNull()
    expect(record.ingressDialect).toBeNull()
    expect(record.clientRequestId).toBeNull()
  })

  test("cost is priced on the upstream model, so an alias does not silently mis-bill", () => {
    // The client asked for `sonnet`; this account sent `claude-sonnet-5`. Pricing the requested name
    // would charge Anthropic's rate for whatever the operator's alias map happened to point at.
    const priced = attemptRecord(
      input({
        upstreamModel: "claude-sonnet-5",
        tokens: { tokensIn: 1_000_000, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    )
    expect(priced.costEstimate).toBe("3.000000")
    expect(priced.costBasis).toBe("metered")
  })

  test("an unpriced model records null and unknown, never a zero that reads as free", () => {
    const record = attemptRecord(input())
    expect(record.upstreamModel).toBe("glm-4.7")
    expect(record.costEstimate).toBeNull()
    expect(record.costBasis).toBe("unknown")
  })

  test("router overhead is total minus upstream, and never negative on a clock hiccup", () => {
    expect(attemptRecord(input()).routerOverheadMs).toBe(4)
    const skewed = { ...input().timing, totalMs: 100, upstreamMs: 120 }
    expect(attemptRecord(input({ timing: skewed })).routerOverheadMs).toBe(0)
  })
})
