import type { HealthStore } from "../src/services/dataplane/health"
import { createRecoveryAccess } from "../src/services/dataplane/recovery-access"
import { createRecoveryCapabilities } from "../src/services/dataplane/recovery-capability"
import type { RoutingCatalog } from "../src/services/dataplane/types"
import type { RecoveryCoordinator } from "../src/services/recovery"

/** Exercise production warm admission; healthy requests must never coordinate durable recovery. */
export function benchmarkRecovery(catalog: RoutingCatalog, health: HealthStore) {
  const held = new Map(catalog.accounts().map((account) => [account.id, account]))
  const offPathOnly = (): never => {
    throw new Error("healthy benchmark request attempted recovery coordination")
  }
  const coordinator: RecoveryCoordinator = {
    bootId: crypto.randomUUID(),
    demand: offPathOnly,
    requestAutomatic: offPathOnly,
    recordOutcome: offPathOnly,
    forget: offPathOnly,
    tick: offPathOnly,
    start: offPathOnly,
    stop: offPathOnly,
  }
  return createRecoveryAccess({
    catalog,
    readAccount: (id) => held.get(id),
    coordinator,
    health,
    capabilities: createRecoveryCapabilities(coordinator.bootId, () => undefined),
    now: () => new Date(),
    retryAfterMs: 1000,
    quotaStaleAfterMs: 600000,
  })
}
