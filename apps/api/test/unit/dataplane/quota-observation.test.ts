import { expect, test } from "bun:test"
import type { AccountRepository, QuotaWindowRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createHealthStore } from "../../../src/services/dataplane/health"
import type { HealthObservation } from "../../../src/services/dataplane/health-observation"
import { createQuotaWindowWriter } from "../../../src/services/dataplane/quota-writer"
import { createMemoryStore } from "../../support/memory-store"

const logger = createLogger({ level: "warn", write: () => {} })
const facts = {
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  authMaterial: "cipher",
  status: "active" as const,
  recoveryGeneration: null,
}
const window = {
  window: "five_hour" as const,
  utilization: 1,
  utilizationSource: "continuous" as const,
  resetSource: "unknown" as const,
  lastCheckedAt: new Date("2026-01-01"),
}
const observation = (generation: number): HealthObservation => ({
  ...facts,
  observationGeneration: generation,
  verdictVersion: 0,
  recoveryGeneration: `recovery-${generation}`,
})
function writer(upsertObservedQuotaWindow: AccountRepository["upsertObservedQuotaWindow"]) {
  return createQuotaWindowWriter({
    logger,
    flushIntervalMs: 1000,
    accounts: {
      upsertQuotaWindow: async () => {
        throw new Error("guarded reading bypassed CAS")
      },
      upsertObservedQuotaWindow,
    },
  })
}

test("health rejects superseded observations and forwards only accepted original identity to quota writer", () => {
  const events: (HealthObservation | undefined)[] = []
  const health = createHealthStore({
    onQuotaWindows: (_id, _windows, expected) => events.push(expected),
  })
  health.reconcile("a", facts)
  const old = health.captureAttempt("a", facts)
  expect(health.acceptsObservation("a", old)).toBe(true)
  health.applyRateLimit("a", { limited: false, quotaWindows: [window] }, new Date(), old)
  expect(events).toEqual([old])
  health.reconcile("a", { ...facts, recoveryGeneration: "new" })
  expect(health.acceptsObservation("a", old)).toBe(false)
  health.applyRateLimit("a", { limited: true, quotaWindows: [window] }, new Date(), old)
  expect(events).toHaveLength(1)
})

test("stale durable CAS is discarded without writes, failure accounting or retry", async () => {
  let calls = 0
  const quota = writer(async (input) => {
    calls++
    expect(input.expected).toMatchObject({ ...facts, recoveryGeneration: "recovery-1" })
    return undefined
  })
  quota.record("a", [window], observation(1))
  await quota.flush()
  await quota.flush()
  expect(calls).toBe(1)
  expect(quota.stats()).toMatchObject({ pending: 0, written: 0, writeFailures: 0 })
})

test("failed old flush never re-labels its windows onto a newer generation", async () => {
  const held = Promise.withResolvers<void>()
  const calls: { generation: string | null; utilization: number | undefined }[] = []
  const quota = writer(async (input) => {
    calls.push({
      generation: input.expected.recoveryGeneration,
      utilization: input.state.utilization,
    })
    if (calls.length === 1) {
      await held.promise
      throw new Error("offline write failed")
    }
    return {} as QuotaWindowRow
  })
  quota.record("a", [window], observation(1))
  const flushing = quota.flush()
  quota.record("a", [{ ...window, utilization: 0.2 }], observation(2))
  held.resolve()
  await flushing
  await quota.flush()
  expect(calls).toEqual([
    { generation: "recovery-1", utilization: 1 },
    { generation: "recovery-2", utilization: 0.2 },
  ])
  expect(quota.stats()).toMatchObject({ pending: 0, written: 1, writeFailures: 1 })
})

test("late old-generation enqueue cannot replace new generation pending evidence", async () => {
  const calls: string[] = []
  const quota = writer(async (input) => {
    calls.push(input.expected.recoveryGeneration ?? "none")
    return {} as QuotaWindowRow
  })
  quota.record("a", [{ ...window, utilization: 0.2 }], observation(2))
  quota.record("a", [window], observation(1))
  await quota.flush()
  expect(calls).toEqual(["recovery-2"])
})

test("shared memory quota fixture enforces durable generation and epoch fences", async () => {
  const store = createMemoryStore()
  const account = await store.accounts.create({
    label: "offline",
    provider: "zai",
    authMaterial: "cipher",
  })
  const input = {
    accountId: account.id,
    expected: { ...account, recoveryGeneration: null as string | null },
    state: window,
  }
  expect(await store.accounts.upsertObservedQuotaWindow(input)).toBeDefined()
  store.rows.recoveries.set(account.id, { generation: "new", state: "pending" })
  expect(await store.accounts.upsertObservedQuotaWindow(input)).toBeUndefined()
  const current = { ...input, expected: { ...input.expected, recoveryGeneration: "new" } }
  expect(await store.accounts.upsertObservedQuotaWindow(current)).toBeDefined()
  account.authRecoveryVersion++
  expect(await store.accounts.upsertObservedQuotaWindow(current)).toBeUndefined()
})
