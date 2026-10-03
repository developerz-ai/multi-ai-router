import { expect, test } from "bun:test"
import { createHealthStore } from "../../../src/services/dataplane/health"
import {
  accountHealthFacts,
  type HealthAccountFacts,
} from "../../../src/services/dataplane/health-observation"
import { account, NOW } from "../dataplane/fixtures"

const facts = (generation: string): HealthAccountFacts => ({
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  authMaterial: "encrypted-fixture",
  status: "active",
  recoveryGeneration: generation,
})

test("new automatic generation fences delayed ordinary and probe failures and quota callbacks", () => {
  for (const designated of [false, true]) {
    const store = createHealthStore()
    const old = store.captureAttempt("a", facts("old"))
    store.beginAttempt("a")
    store.reconcile("a", facts("new"))
    store.recordFailure(
      "a",
      { kind: "credits-exhausted", message: "late stream" },
      NOW,
      { recoveryProbe: designated },
      old,
    )
    store.applyRateLimit(
      "a",
      {
        limited: true,
        resetSource: "provider-reported",
        windows: [],
        resetsAt: new Date(NOW.getTime() + 60000),
      },
      NOW,
      old,
    )
    expect(store.stateOf("a").breaker.status).toBe("active")
    expect(store.stateOf("a").lastSignalAt).toBeNull()
    store.endAttempt("a")
    const current = store.captureAttempt("a", facts("new"))
    store.recordFailure("a", { kind: "credits-exhausted", message: "current" }, NOW, {}, current)
    expect(store.stateOf("a").breaker.status).toBe("exhausted")
  }
})

test("generation reconciliation preserves quota and delayed success cannot clear current cooldown", () => {
  const store = createHealthStore()
  const old = store.captureAttempt("a", facts("old"))
  store.applyRateLimit(
    "a",
    {
      limited: false,
      resetSource: "unknown",
      windows: [],
      quotaWindows: [
        {
          window: "five_hour",
          utilization: 0.8,
          utilizationSource: "continuous",
          resetSource: "unknown",
          lastCheckedAt: NOW,
        },
      ],
    },
    NOW,
    old,
  )
  store.reconcile("a", facts("new"))
  const current = store.captureAttempt("a", facts("new"))
  store.recordFailure(
    "a",
    { kind: "rate-limited", retryAfterSeconds: 30, message: "429" },
    NOW,
    {},
    current,
  )
  store.recordSuccess("a", old)
  expect(store.stateOf("a").breaker.status).toBe("cooling_down")
  expect(store.stateOf("a").quotaWindows[0]?.utilization).toBe(0.8)
  const staleSelection = store.captureAttempt("a", facts("old"))
  store.recordFailure(
    "a",
    { kind: "credits-exhausted", message: "old plan" },
    NOW,
    {},
    staleSelection,
  )
  expect(store.stateOf("a").breaker.status).toBe("cooling_down")
})

test("outcome revision changes within one generation retain its stream observation", () => {
  const upstream = account("a")
  const recovery = {
    revision: 1,
    generation: "same",
    lifecycleVersion: 0,
    state: "issued" as const,
    quotaRevisions: {},
    nextAllowedAt: NOW,
  }
  const first = { ...upstream, snapshot: { ...upstream.snapshot, recovery } }
  const store = createHealthStore()
  const observation = store.captureAttempt("a", accountHealthFacts(first))
  store.reconcile(
    "a",
    accountHealthFacts({
      ...first,
      snapshot: { ...first.snapshot, recovery: { ...recovery, revision: 2, state: "succeeded" } },
    }),
  )
  store.recordFailure(
    "a",
    { kind: "credits-exhausted", message: "current stream" },
    NOW,
    {},
    observation,
  )
  expect(store.stateOf("a").breaker.status).toBe("exhausted")
})
