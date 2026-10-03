import { describe, expect, test } from "bun:test"
import { latestResetDeadline } from "@multi-ai-router/core"
import { reportedReset } from "../../../src/services/routing/backoff"
import { HEALTHY, recordFailure } from "../../../src/services/routing/breaker"

const now = new Date("2026-10-03T12:00:00Z")
describe("applicable reset deadlines", () => {
  test("all applicable absolute and relative constraints must pass", () => {
    for (const [absolute, relative] of [
      [10, 300],
      [300, 10],
    ]) {
      const facts = {
        resetsAt: new Date(now.getTime() + absolute * 1000),
        retryAfterSeconds: relative,
      }
      expect(latestResetDeadline(facts, now)?.getTime()).toBe(now.getTime() + 300000)
      expect(reportedReset(facts, now)?.getTime()).toBe(now.getTime() + 300000)
      expect(
        recordFailure(
          HEALTHY,
          { kind: "rate-limited", message: "limited", ...facts },
          now,
        ).cooldownUntil?.getTime(),
      ).toBe(now.getTime() + 300000)
    }
  })
  test("elapsed and invalid readings cannot retrip a failed probe into the past", () => {
    for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
      expect(
        reportedReset({ resetsAt: new Date(now.getTime() - 1), retryAfterSeconds: seconds }, now),
      ).toBeNull()
    }
    expect(
      reportedReset({ resetsAt: new Date(Number.NaN), retryAfterSeconds: 0.25 }, now)?.getTime(),
    ).toBe(now.getTime() + 250)
    const after = recordFailure(
      HEALTHY,
      { kind: "server-error", message: "unavailable", resetsAt: new Date(now.getTime() - 1) },
      now,
      { recoveryProbe: true },
    )
    expect(after.cooldownUntil?.getTime()).toBeGreaterThan(now.getTime())
    expect(after.cooldownSource).toBe("estimated")
  })
})
