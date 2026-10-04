import type { SdkQuotaStore } from "../../providers"
import type { SdkUsageGaugeObservation } from "../../providers/claude-sdk/usage-gauge"
import type { HealthStore } from "./health"
import { accountHealthFacts } from "./health-observation"
import type { RoutingCatalog } from "./types"

/** Capture quota authority before SDK work; delayed gauge replies never acquire fresh authority. */
export function gaugeObservationCapture(
  catalog: RoutingCatalog,
  health: HealthStore,
  quota: SdkQuotaStore,
): (accountId: string) => SdkUsageGaugeObservation | undefined {
  return (accountId) => {
    const account = catalog.accounts().find((candidate) => candidate.id === accountId)
    if (account === undefined) return undefined
    const observation = health.captureAttempt(accountId, accountHealthFacts(account))
    const accepts = () => health.acceptsObservation(accountId, observation)
    return {
      accepts,
      onReading(reading, at) {
        if (!accepts()) return
        const snapshot = quota.ingestGauge(accountId, reading, at)
        health.applyRateLimit(accountId, snapshot.signal, at, observation)
      },
    }
  }
}
