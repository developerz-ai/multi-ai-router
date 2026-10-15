import { describe, expect, test } from "bun:test"
import {
  attemptContribution,
  terminalContribution,
} from "../../../src/repositories/usage-contribution-values"
import type { NewUsageRecordRow } from "../../../src/schema/usage-records"

/**
 * The unpriced measure on a contribution payload: 1 for an attempt whose cost basis is `unknown`
 * that used tokens, 0 for everything else. Token-less failures stay out so a refused request
 * cannot read as unpriced traffic.
 */

const fallback = new Date("2026-10-14T00:00:00Z")

const row = (over: Partial<NewUsageRecordRow> = {}): NewUsageRecordRow => ({
  correlationId: crypto.randomUUID(),
  outcome: "success",
  costBasis: "unknown",
  costEstimate: null,
  ...over,
})

describe("unpriced attempts on contribution payloads", () => {
  test("an unknown-basis attempt that used tokens counts 1 and keeps both cost columns 0", () => {
    const payload = attemptContribution(
      row({ tokensIn: 120, tokensOut: 40, createdAt: fallback }),
      fallback,
    )
    expect(payload.unpricedAttempts).toBe(1)
    expect(payload.costMetered).toBe("0")
    expect(payload.costNotional).toBe("0")
  })

  test("a token-less failed attempt on an unknown model adds 0", () => {
    const payload = attemptContribution(
      row({ tokensIn: 0, tokensOut: 0, outcome: "upstream_error" }),
      fallback,
    )
    expect(payload.unpricedAttempts).toBe(0)
  })

  test("a priced attempt adds 0 whatever its basis", () => {
    for (const basis of ["metered", "notional"] as const) {
      const payload = attemptContribution(
        row({ costBasis: basis, costEstimate: "0.500000", tokensIn: 10, tokensOut: 5 }),
        fallback,
      )
      expect(payload.unpricedAttempts).toBe(0)
    }
  })

  test("a terminal payload carries no measure: request-level rows carry no cost", () => {
    const payload = terminalContribution({
      correlationId: crypto.randomUUID(),
      winnerEventId: null,
      apiKeyId: null,
      accountId: null,
      poolId: null,
      provider: null,
      model: null,
      upstreamModel: null,
      outcome: "success",
      errorClass: null,
      responseStatus: 200,
      httpStatus: 200,
      attributionKind: "winning-attempt",
      startedAt: fallback,
      settledAt: fallback,
    })
    expect("unpricedAttempts" in payload).toBe(false)
  })
})
