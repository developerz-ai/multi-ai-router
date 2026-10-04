import { expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import { createHealthStore } from "../../../src/services/dataplane/health"

const facts = {
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  authMaterial: "offline-cipher",
  status: "active" as const,
  recoveryGeneration: null,
}
const now = new Date("2026-10-01T12:00:00Z")
const window: QuotaWindowState = {
  window: "five_hour",
  utilization: 0.4,
  utilizationSource: "continuous",
  resetSource: "unknown",
  lastCheckedAt: now,
}

test("blocked verdict bundles only quota accepted from its exact attempt", () => {
  const bundles: (readonly QuotaWindowState[] | undefined)[] = []
  const writes: (readonly QuotaWindowState[])[] = []
  const health = createHealthStore({
    onBlocked: (_id, _status, _observation, windows) => bundles.push(windows),
    onQuotaWindows: (_id, windows) => writes.push(windows),
  })
  health.reconcile("a", facts)
  const older = health.captureAttempt("a", facts)
  health.applyRateLimit("a", { limited: false, quotaWindows: [window] }, now, older)
  const current = health.captureAttempt("a", facts)
  const currentWindow = { ...window, window: "seven_day" as const }
  health.applyRateLimit("a", { limited: false, quotaWindows: [currentWindow] }, now, current)
  health.recordFailure("a", { kind: "credits-exhausted", message: "offline" }, now, {}, current)
  expect(health.stateOf("a").quotaWindows).toHaveLength(2)
  expect(writes).toEqual([[window], [currentWindow]])
  expect(bundles).toEqual([[currentWindow]])
})

test("multiple readings from one attempt retain each accepted window in its status bundle", () => {
  let bundle: readonly QuotaWindowState[] | undefined
  const health = createHealthStore({
    onBlocked: (_id, _status, _observation, windows) => {
      bundle = windows
    },
  })
  health.reconcile("a", facts)
  const observation = health.captureAttempt("a", facts)
  const second = { ...window, window: "seven_day" as const }
  health.applyRateLimit("a", { limited: false, quotaWindows: [window] }, now, observation)
  health.applyRateLimit("a", { limited: false, quotaWindows: [second] }, now, observation)
  health.recordFailure(
    "a",
    { kind: "auth", message: "offline" },
    now,
    { authKind: "oauth" },
    observation,
  )
  expect(bundle).toEqual([window, second])
})

test("superseded evidence cannot enter a replacement attempt's status bundle", () => {
  const bundles: (readonly QuotaWindowState[] | undefined)[] = []
  const health = createHealthStore({
    onBlocked: (_id, _status, _observation, windows) => bundles.push(windows),
  })
  health.reconcile("a", facts)
  const stale = health.captureAttempt("a", facts)
  const replacement = { ...facts, authRecoveryVersion: 1 }
  health.reconcile("a", replacement)
  health.applyRateLimit("a", { limited: false, quotaWindows: [window] }, now, stale)
  const current = health.captureAttempt("a", replacement)
  health.recordFailure("a", { kind: "credits-exhausted", message: "offline" }, now, {}, current)
  expect(bundles).toEqual([undefined])
})
