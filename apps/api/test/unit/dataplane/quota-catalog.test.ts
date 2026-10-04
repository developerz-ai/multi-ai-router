import { expect, test } from "bun:test"
import { createSdkQuotaStore } from "../../../src/providers"
import { quotaCatalogReconciler } from "../../../src/services/dataplane/quota-catalog"
import { subscriptionAccount } from "./fixtures"

const now = new Date("2026-01-01")
const oldReading = {
  status: "rejected",
  rateLimitType: "five_hour",
  utilization: 1,
  resetsAt: now.getTime() / 1000 + 3600,
}

test("same-L new recovery generation cannot republish an old SDK bucket through a different new bucket", () => {
  const store = createSdkQuotaStore()
  const reconcile = quotaCatalogReconciler(store)
  const account = subscriptionAccount("a")
  reconcile([account])
  store.ingest("a", oldReading, now)
  const next = {
    ...account,
    snapshot: {
      ...account.snapshot,
      recovery: {
        revision: 0,
        generation: "new",
        lifecycleVersion: 0,
        state: "pending" as const,
        nextAllowedAt: now,
        quotaRevisions: {},
      },
    },
  }
  reconcile([next])
  expect(store.snapshot("a", now)).toBeNull()
  const fresh = store.ingest(
    "a",
    { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.2 },
    now,
  )
  expect(fresh?.windows.map((window) => window.window)).toEqual(["seven_day"])
  expect(fresh?.signal.limited).toBe(false)
})

test("unchanged facts preserve buckets, removed accounts lose only their own buckets", () => {
  const store = createSdkQuotaStore()
  const reconcile = quotaCatalogReconciler(store)
  const a = subscriptionAccount("a"),
    b = subscriptionAccount("b")
  reconcile([a, b])
  store.ingest("a", oldReading, now)
  store.ingest("b", oldReading, now)
  reconcile([{ ...a }, { ...b }])
  expect(store.snapshot("a", now)?.signal.limited).toBe(true)
  reconcile([b])
  expect(store.snapshot("a", now)).toBeNull()
  expect(store.snapshot("b", now)?.signal.limited).toBe(true)
})

test("same-L credential changes and each independent recovery epoch discard old buckets", () => {
  for (const patch of [
    { authMaterial: "new" },
    { lifecycleVersion: 1 },
    { healthRecoveryVersion: 1 },
    { authRecoveryVersion: 1 },
  ]) {
    const store = createSdkQuotaStore()
    const reconcile = quotaCatalogReconciler(store)
    const account = subscriptionAccount("a")
    reconcile([account])
    store.ingest("a", oldReading, now)
    reconcile([{ ...account, ...patch }])
    expect(store.snapshot("a", now)).toBeNull()
  }
})
