import { describe, expect, test } from "bun:test"
import { classifySdkFailure } from "../../../src/providers/claude-sdk/errors"
import { SDK_FAILURE_RULES } from "../../../src/providers/claude-sdk/failure-rules"

/**
 * 101 finding 05.14: "Extra Usage gated" is provoked by the request (a client harness fingerprint,
 * `scrub.ts`) and fails identically on every account. It keeps its failover, but its classification
 * says `requestAttributable` so routing does not cool each account the chain tries.
 */

describe("a request-attributable refusal", () => {
  test("extra-usage-gated carries requestAttributable", () => {
    for (const message of [
      "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
      "You need extra usage for this request. Manage it at claude.ai/settings/usage",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))
      expect(classification.signal).toBe("claude-sdk:extra-usage-gated")
      expect(classification.requestAttributable).toBe(true)
      expect(classification.retryable).toBe(true)
      // It clears with time, so a one-account chain keeps the held 429 (failover.ts).
      expect(classification).not.toHaveProperty("permanentForRequest")
    }
  })

  test("only the refusals the request provokes on every Claude transport alike carry it", () => {
    const flagged = SDK_FAILURE_RULES.filter((rule) => rule.requestAttributable).map(
      (rule) => rule.signal,
    )
    // structured-output-unsupported: R1, `structured-output-refusal.test.ts`.
    expect(flagged).toEqual([
      "claude-sdk:structured-output-unsupported",
      "claude-sdk:extra-usage-gated",
    ])
    for (const message of [
      "API Error: 429 rate limit exceeded",
      "Credit balance is too low",
      "OAuth token has expired",
      "prompt is too long",
      "something nobody recognises",
    ]) {
      expect(classifySdkFailure(new Error(message)).classification).not.toHaveProperty(
        "requestAttributable",
      )
    }
  })
})
