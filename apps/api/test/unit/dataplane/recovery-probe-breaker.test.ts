import { expect, test } from "bun:test"
import { HEALTHY, phase, recordFailure } from "../../../src/services/routing/breaker"

const now = new Date("2026-10-03T16:00:00Z")
for (const kind of ["server-error", "timeout", "connection"] as const) {
  test(`failed half-open ${kind} retrips even below ordinary threshold`, () => {
    const before = {
      status: "cooling_down" as const,
      cooldownUntil: new Date(now.getTime() - 1),
      consecutiveFailures: 0,
      cooldownSource: "estimated" as const,
    }
    const after = recordFailure(before, { kind, message: "synthetic" }, now, {
      failureThreshold: 10,
      baseBackoffMs: 1000,
    })
    expect(phase(after, now)).toBe("open")
    expect(after.cooldownUntil?.getTime()).toBeGreaterThan(now.getTime())
  })
}
test("operator recovery marked as probe retrips; ordinary healthy failure retains threshold", () => {
  const failure = { kind: "server-error" as const, message: "synthetic" }
  expect(phase(recordFailure(HEALTHY, failure, now, { recoveryProbe: true }), now)).toBe("open")
  expect(recordFailure(HEALTHY, failure, now).status).toBe("active")
})
for (const kind of ["client-error", "stale-session", "busy-session"] as const) {
  test(`recovery ${kind} remains a request failure with no account strike`, () => {
    expect(
      recordFailure(HEALTHY, { kind, message: "synthetic" }, now, { recoveryProbe: true }),
    ).toBe(HEALTHY)
  })
}
