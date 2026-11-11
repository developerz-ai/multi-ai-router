import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  DEFAULT_MAX_REPORTED_RESET_SECONDS,
  HEALTHY,
  recordFailure,
} from "../../../src/services/routing"
import { lengthenRefusal } from "../../../src/services/routing/credential-rejection"
import { at, NOW } from "./fixtures"

const TEN_YEARS_S = 10 * 365 * 86_400
const limited = (overrides: Partial<AttemptFailure>): AttemptFailure => ({
  kind: "rate-limited",
  message: "limited",
  ...overrides,
})

// Plan 101 (04 handoff): a misread or hostile reset parked an account for as long as it said.
describe("a reported reset is bounded by ROUTING_MAX_REPORTED_RESET_SECONDS", () => {
  test("a ten-year Retry-After cools to the ceiling, labeled estimated", () => {
    const state = recordFailure(HEALTHY, limited({ retryAfterSeconds: TEN_YEARS_S }), NOW)
    expect(state.cooldownUntil).toEqual(at(DEFAULT_MAX_REPORTED_RESET_SECONDS * 1_000))
    expect(state.cooldownSource).toBe("estimated")
  })

  test("a configured ceiling below the default wins", () => {
    const state = recordFailure(
      HEALTHY,
      limited({ resetsAt: at(TEN_YEARS_S * 1_000), resetSource: "provider-reported" }),
      NOW,
      { maxReportedResetSeconds: 3_600 },
    )
    expect(state.cooldownUntil).toEqual(at(3_600_000))
    expect(state.cooldownSource).toBe("estimated")
  })

  test("a reset inside the ceiling keeps the provider's instant and label", () => {
    const state = recordFailure(HEALTHY, limited({ resetsAt: at(600_000) }), NOW)
    expect(state.cooldownUntil).toEqual(at(600_000))
    expect(state.cooldownSource).toBe("provider-reported")
  })

  test("a limiter reading lengthening a refusal is bounded the same way", () => {
    const refused = {
      status: "cooling_down" as const,
      cooldownUntil: at(60_000),
      cooldownSource: "estimated" as const,
      cooldownReason: "credential-rejected" as const,
      consecutiveFailures: 1,
    }
    const lengthened = lengthenRefusal(refused, { retryAfterSeconds: TEN_YEARS_S }, NOW, 7_200)
    expect(lengthened.cooldownUntil).toEqual(at(7_200_000))
    expect(lengthened.cooldownSource).toBe("estimated")
  })
})
