import { expect, test } from "bun:test"
import { createSdkQuotaStore } from "../../../src/providers"
import type { SdkUsageGaugeReading } from "../../../src/providers/claude-sdk/quota-reading"
import { gaugeObservationCapture } from "../../../src/services/dataplane/gauge-observation"
import { createHealthStore } from "../../../src/services/dataplane/health"
import type { HealthObservation } from "../../../src/services/dataplane/health-observation"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import { catalog, subscriptionAccount } from "./fixtures"

const now = new Date("2026-10-03T00:00:00Z")
const reading: SdkUsageGaugeReading = {
  available: true,
  subscriptionType: null,
  windows: [{ kind: "five_hour", utilization: 0.8, resetsAt: new Date(now.getTime() + 3600000) }],
}
for (const mutation of ["none", "generation", "cipher", "deleted"] as const) {
  test(`captured gauge ${mutation} admission cannot reacquire newer quota authority`, () => {
    const original = subscriptionAccount("sub")
    const accounts = [original]
    const catalogView = catalog(accounts)
    const writes: { id: string; observation: HealthObservation | undefined }[] = []
    const health = createHealthStore({
      onQuotaWindows: (id, _windows, observation) => writes.push({ id, observation }),
    })
    const quota = createSdkQuotaStore()
    const capture = gaugeObservationCapture(catalogView, health, quota)
    const context = capture("sub")
    if (!context) throw new Error("fixture account missing")
    if (mutation === "deleted") {
      accounts.splice(0)
      health.reset("sub")
    } else if (mutation !== "none") {
      const facts = accountHealthFacts(original)
      health.reconcile("sub", {
        ...facts,
        ...(mutation === "generation"
          ? { recoveryGeneration: crypto.randomUUID() }
          : { authMaterial: "rotated-same-lifecycle-cipher" }),
      })
    }
    expect(context.accepts()).toBe(mutation === "none")
    context.onReading(reading, now)
    expect(writes).toHaveLength(mutation === "none" ? 1 : 0)
    expect(quota.snapshot("sub", now)?.windows.length ?? 0).toBe(mutation === "none" ? 1 : 0)
    expect(health.stateOf("sub").quotaWindows.length).toBe(mutation === "none" ? 1 : 0)
    if (mutation === "none")
      expect(writes[0]?.observation).toMatchObject({
        lifecycleVersion: 0,
        authMaterial: null,
        recoveryGeneration: null,
      })
    else expect(capture("missing")).toBeUndefined()
  })
}
