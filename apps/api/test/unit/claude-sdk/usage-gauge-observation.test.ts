import { expect, test } from "bun:test"
import { createSdkQuotaStore } from "../../../src/providers"
import { createSdkUsageGauge } from "../../../src/providers/claude-sdk/usage-gauge"
import { createHealthStore } from "../../../src/services/dataplane/health"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import { subscriptionAccount } from "../dataplane/fixtures"

const now = new Date("2026-01-01")
const payload = {
  rate_limits_available: true,
  subscription_type: "max",
  rate_limits: {
    five_hour: { utilization: 42, resets_at: new Date(now.getTime() + 3600000).toISOString() },
  },
}
function fixture() {
  const sdk = createSdkQuotaStore()
  const persisted: unknown[] = []
  const health = createHealthStore({
    onQuotaWindows: (_id, windows, observation) => persisted.push({ windows, observation }),
  })
  let account = subscriptionAccount("a")
  health.reconcile("a", accountHealthFacts(account))
  const gauge = createSdkUsageGauge({
    enabled: true,
    timeoutMs: 1000,
    minIntervalMs: 0,
    now: () => now,
    capture: (id) => {
      const observation = health.captureAttempt(id, accountHealthFacts(account))
      return {
        accepts: () => health.acceptsObservation(id, observation),
        onReading: (reading, at) => {
          if (!health.acceptsObservation(id, observation)) return
          const snapshot = sdk.ingestGauge(id, reading, at)
          health.applyRateLimit(id, snapshot.signal, at, observation)
        },
      }
    },
  })
  return {
    sdk,
    health,
    gauge,
    persisted,
    rotate() {
      account = { ...account, authRecoveryVersion: account.authRecoveryVersion + 1 }
      health.reconcile("a", accountHealthFacts(account))
      sdk.forget("a")
    },
  }
}

test("deferred gauge keeps original identity and cannot ingest or persist after account recovery", async () => {
  const f = fixture(),
    answer = Promise.withResolvers<unknown>()
  const observation = f.gauge.capture("a")
  const reading = f.gauge.observe(
    "a",
    { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => answer.promise },
    observation,
  )
  f.rotate()
  answer.resolve(payload)
  await reading
  expect(f.sdk.snapshot("a", now)).toBeNull()
  expect(f.persisted).toHaveLength(0)
  expect(f.health.stateOf("a").quotaWindows).toHaveLength(0)
})

test("accepted gauge forwards its originally captured observation to durable quota callback", async () => {
  const f = fixture()
  const observation = f.gauge.capture("a")
  await f.gauge.observe(
    "a",
    { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => payload },
    observation,
  )
  expect(f.sdk.snapshot("a", now)?.windows[0]?.utilization).toBe(0.42)
  expect(f.persisted).toHaveLength(1)
  expect(f.persisted[0]).toMatchObject({
    observation: { authRecoveryVersion: 0, recoveryGeneration: null },
  })
})

test("production factory never recaptures a missing or already-stale context at first content", async () => {
  const f = fixture()
  let reads = 0
  const source = {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
      reads++
      return payload
    },
  }
  await f.gauge.observe("a", source)
  const old = f.gauge.capture("a")
  f.rotate()
  await f.gauge.observe("a", source, old)
  expect(reads).toBe(0)
  expect(f.persisted).toHaveLength(0)
})
