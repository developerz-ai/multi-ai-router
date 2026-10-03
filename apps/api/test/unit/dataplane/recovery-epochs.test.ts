import { expect, test } from "bun:test"
import { createHealthStore } from "../../../src/services/dataplane/health"
import type { HealthAccountFacts } from "../../../src/services/dataplane/health-observation"
import type { AttemptFailure } from "../../../src/services/routing"

const facts: HealthAccountFacts = {
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  authMaterial: "synthetic-a",
  status: "active",
}
const at = new Date(1000)

test("late auth after enable and successful authorization cannot repark or decrement load", () => {
  const health = createHealthStore()
  health.reconcile("a", facts)
  const old = health.captureAttempt("a", facts)
  health.beginAttempt("a")
  health.reconcile("a", {
    ...facts,
    lifecycleVersion: 2,
    healthRecoveryVersion: 1,
    authRecoveryVersion: 1,
  })
  health.recordFailure(
    "a",
    { kind: "auth", message: "synthetic auth" },
    at,
    { authKind: "oauth" },
    old,
  )
  expect(health.stateOf("a").breaker.status).toBe("active")
  expect(health.stateOf("a").inFlight).toBe(1)
  health.endAttempt("a", 17)
  expect(health.stateOf("a").inFlight).toBe(0)
  expect(health.stateOf("a").recentTokens).toBe(17)
})

test("old success cannot erase a newer concurrent quota verdict", () => {
  const health = createHealthStore({ jitter: () => 0 })
  const old = health.captureAttempt("a", facts)
  const newer = health.captureAttempt("a", facts)
  health.recordFailure(
    "a",
    { kind: "rate-limited", message: "synthetic quota", retryAfterSeconds: 60 },
    at,
    {},
    newer,
  )
  health.recordSuccess("a", old)
  expect(health.stateOf("a").breaker.status).toBe("cooling_down")
  health.recordFailure(
    "a",
    { kind: "credits-exhausted", message: "synthetic credits" },
    at,
    {},
    newer,
  )
  health.recordSuccess("a", old)
  expect(health.stateOf("a").breaker.status).toBe("exhausted")
})

test("preselected old ciphertext cannot restore old observation authority", () => {
  const health = createHealthStore()
  health.reconcile("a", facts)
  health.reconcile("a", { ...facts, authMaterial: "synthetic-b" })
  const oldPlan = health.captureAttempt("a", facts)
  health.recordFailure("a", { kind: "auth", message: "synthetic auth" }, at, {}, oldPlan)
  expect(health.stateOf("a").breaker.status).toBe("active")
  const current = health.captureAttempt("a", { ...facts, authMaterial: "synthetic-b" })
  health.recordFailure("a", { kind: "auth", message: "synthetic auth" }, at, {}, current)
  expect(health.stateOf("a").breaker.status).toBe("needs_reauth")
})

test("old probe cleanup does not release replacement after recovery", () => {
  const health = createHealthStore({ jitter: () => 0 })
  health.reconcile("a", facts)
  health.recordFailure(
    "a",
    { kind: "rate-limited", message: "synthetic", retryAfterSeconds: 1 },
    at,
  )
  const first = health.admitProbe("a", new Date(3000))
  expect(first.held).toBeTrue()
  health.reconcile("a", { ...facts, lifecycleVersion: 1, healthRecoveryVersion: 1 })
  health.recordFailure(
    "a",
    { kind: "rate-limited", message: "synthetic", retryAfterSeconds: 1 },
    new Date(3000),
  )
  const next = health.admitProbe("a", new Date(5000))
  expect(next.held).toBeTrue()
  health.releaseProbe("a", first.token)
  expect(health.stateOf("a").probeHeldUntil).not.toBeNull()
  health.releaseProbe("a", next.token)
  expect(health.stateOf("a").probeHeldUntil).toBeNull()
})

test("routine ciphertext rotation preserves a configured cooldown and its probe authority", () => {
  const health = createHealthStore()
  const current = { ...facts, status: "cooling_down" as const }
  health.reconcile("a", current)
  health.recordFailure("a", { kind: "auth", message: "synthetic refused key" }, at, {
    authKind: "api-key",
  })
  const before = health.stateOf("a").breaker
  health.reconcile("a", { ...current, authMaterial: "synthetic-new" })
  expect(health.stateOf("a").breaker).toBe(before)
})

const failures: readonly { failure: AttemptFailure; expected: string }[] = [
  { failure: { kind: "auth", message: "synthetic auth" }, expected: "needs_reauth" },
  { failure: { kind: "credits-exhausted", message: "synthetic billing" }, expected: "exhausted" },
  {
    failure: { kind: "rate-limited", message: "synthetic quota", retryAfterSeconds: 60 },
    expected: "cooling_down",
  },
]
for (const { failure, expected } of failures) {
  for (const failureFirst of [true, false]) {
    test(`${failure.kind} verdict survives concurrent success (failureFirst=${failureFirst})`, () => {
      const health = createHealthStore()
      const success = health.captureAttempt("a", facts)
      const failed = health.captureAttempt("a", facts)
      if (!failureFirst) health.recordSuccess("a", success)
      health.recordFailure("a", failure, at, { authKind: "oauth" }, failed)
      if (failureFirst) health.recordSuccess("a", success)
      expect(health.stateOf("a").breaker.status).toBe(expected)
    })
  }
}

test("skipped enable then auth honors full recovery while auth alone preserves billing", () => {
  const health = createHealthStore()
  health.reconcile("a", facts)
  health.beginAttempt("a")
  health.recordFailure("a", { kind: "credits-exhausted", message: "synthetic billing" }, at)
  health.reconcile("a", { ...facts, lifecycleVersion: 1, authRecoveryVersion: 1 })
  expect(health.stateOf("a").breaker.status).toBe("exhausted")
  health.reconcile("a", {
    ...facts,
    lifecycleVersion: 3,
    healthRecoveryVersion: 1,
    authRecoveryVersion: 2,
  })
  expect(health.stateOf("a").breaker.status).toBe("active")
  expect(health.stateOf("a").inFlight).toBe(1)
  health.endAttempt("a", 17)
  expect(health.stateOf("a").recentTokens).toBe(17)
})
