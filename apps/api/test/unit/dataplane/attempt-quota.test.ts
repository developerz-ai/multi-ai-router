import { expect, test } from "bun:test"
import { credentialFingerprint } from "@multi-ai-router/db"
import { createHealthStore } from "../../../src/services/dataplane"
import { attemptQuota } from "../../../src/services/dataplane/attempt-quota"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import type { DispatchRuntime } from "../../../src/services/dataplane/runtime"
import { account, NOW } from "./fixtures"

function probing() {
  const upstream = account("a")
  const health = createHealthStore({ jitter: () => 0 })
  const observation = health.captureAttempt("a", accountHealthFacts(upstream))
  const quota = attemptQuota(
    { health } as unknown as DispatchRuntime,
    "a",
    observation,
    () => true,
    new AbortController().signal,
  )
  // First output: the probe's success is published, and its stored row comes back.
  health.recordSuccess("a", observation)
  const acknowledge = (lifecycleVersion: number) =>
    health.reconcile("a", {
      ...accountHealthFacts(upstream),
      lifecycleVersion,
      breaker: {
        accountId: "a",
        revision: 1,
        credentialFingerprint: credentialFingerprint(upstream.authMaterial),
        lifecycleVersion,
        healthRecoveryVersion: 0,
        authRecoveryVersion: 0,
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        cooldownSource: "unknown",
        cooldownReason: null,
        probeHeldUntil: null,
      } as never,
    })
  return { health, quota, acknowledge }
}
const LIMITED = {
  limited: true,
  resetsAt: new Date(NOW.getTime() + 3_600_000),
  resetSource: "provider-reported",
  quotas: [],
} as never

test("a limit read after a probe settled at its first output still cools the account", () => {
  const { health, quota, acknowledge } = probing()
  acknowledge(0)
  quota.observe(LIMITED, NOW)

  expect(quota.limited()).toBe(true)
  expect(health.stateOf("a").breaker.status).toBe("cooling_down")
})

test("a limit read after the account itself changed is still refused", () => {
  const { health, quota, acknowledge } = probing()
  acknowledge(1)
  quota.observe(LIMITED, NOW)

  expect(quota.limited()).toBe(false)
  expect(health.stateOf("a").breaker.status).toBe("active")
})
