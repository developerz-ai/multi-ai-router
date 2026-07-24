import { describe, expect, test } from "bun:test"
import {
  isSuccessOutcome,
  ROUTER_ERROR_CODES,
  USAGE_OUTCOME_SUCCESS,
  UsageFault,
  UsageOutcome,
  usageOutcomeFault,
  usageOutcomeForErrorCode,
} from "../../src/index"

/**
 * The taxonomy exists to answer one question without a join: *"3% of my requests failed — whose
 * problem is that?"* These tests pin the distinctions that question depends on, and the two that
 * were previously lost: a relayed upstream error and a malformed client request both reported as
 * `no_healthy_account`, which reads as an operator capacity problem and is neither.
 */

describe("usage outcome taxonomy", () => {
  test("a relayed upstream error is not a capacity problem", () => {
    expect(UsageOutcome.options).toContain("upstream_error")
    expect(usageOutcomeFault("upstream_error")).toBe("upstream")
    expect(usageOutcomeFault("no_healthy_account")).toBe("capacity")
  })

  test("a malformed client request is the caller's fault, not the router's", () => {
    expect(UsageOutcome.options).toContain("client_error")
    expect(usageOutcomeFault("client_error")).toBe("client")
    expect(usageOutcomeFault("router_error")).toBe("router")
  })

  test("rate-limited and out-of-credits never collapse into each other", () => {
    // A clock fixes one, a human fixes the other. Same fault group, different remedy, so they stay
    // distinct outcomes — folding them makes a dead pool look merely throttled.
    expect(usageOutcomeFault("quota_exhausted")).toBe("capacity")
    expect(usageOutcomeFault("credits_exhausted")).toBe("capacity")
    expect(UsageOutcome.parse("quota_exhausted")).not.toBe(UsageOutcome.parse("credits_exhausted"))
  })

  test("success is the only non-failure, and the only one with no fault", () => {
    expect(isSuccessOutcome(USAGE_OUTCOME_SUCCESS)).toBe(true)
    expect(usageOutcomeFault("success")).toBe("none")
    for (const outcome of UsageOutcome.options) {
      const noFault = usageOutcomeFault(outcome) === "none"
      expect(noFault).toBe(isSuccessOutcome(outcome))
    }
  })

  test("every outcome has a fault, and every fault group is populated", () => {
    const groups = new Set(UsageOutcome.options.map(usageOutcomeFault))
    expect([...groups].sort()).toEqual([...UsageFault.options].sort())
  })

  test("the admin plane's error codes are not data-plane outcomes", () => {
    // The admin plane writes no usage rows. Either code appearing on an attempt would mean a
    // handler threw from the wrong plane, which is a bug and reports as one.
    expect(UsageOutcome.options).not.toContain("admin_auth_failed")
    expect(UsageOutcome.options).not.toContain("csrf_token_invalid")
    expect(usageOutcomeForErrorCode("admin_auth_failed")).toBe("router_error")
    expect(usageOutcomeForErrorCode("csrf_token_invalid")).toBe("router_error")
  })

  test("every router error code maps to an outcome the enum admits", () => {
    for (const code of ROUTER_ERROR_CODES) {
      expect(UsageOutcome.options).toContain(usageOutcomeForErrorCode(code))
    }
  })

  test("a data-plane error code keeps its own identity in the report", () => {
    expect(usageOutcomeForErrorCode("quota_exhausted")).toBe("quota_exhausted")
    expect(usageOutcomeForErrorCode("credits_exhausted")).toBe("credits_exhausted")
    expect(usageOutcomeForErrorCode("upstream_auth_failed")).toBe("upstream_auth_failed")
    expect(usageOutcomeForErrorCode("credential_decrypt_failed")).toBe("credential_decrypt_failed")
  })

  test("rejects anything outside the vocabulary", () => {
    for (const value of ["rate_limited", "exhausted", "timeout", "SUCCESS", ""]) {
      expect(UsageOutcome.safeParse(value).success).toBe(false)
    }
  })
})
