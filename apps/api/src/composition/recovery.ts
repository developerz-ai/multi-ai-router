import {
  type AccountRepository,
  createRecoveryRepository,
  type Database,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import type { RoutingCatalogStore } from "../services/catalog"
import type { HealthStore } from "../services/dataplane/health"
import { createRecoveryAccess } from "../services/dataplane/recovery-access"
import { createRecoveryCapabilities } from "../services/dataplane/recovery-capability"
import type { RoutableAccount } from "../services/dataplane/types"
import { createRecoveryCoordinator } from "../services/recovery"
import { DEFAULT_QUOTA_SPENT_THRESHOLD } from "../services/routing"

export function createRecoveryComponents(deps: {
  database: Database
  accounts: AccountRepository
  health: HealthStore
  catalog: RoutingCatalogStore
  config: Env["recovery"]
  logger: Logger
  now: () => Date
}) {
  let held = new Map(deps.catalog.accounts().map((account) => [account.id, account]))
  const repository = createRecoveryRepository(deps.database)
  const coordinator = createRecoveryCoordinator({
    repository,
    accounts: deps.accounts,
    config: { ...deps.config, quotaSpentThreshold: DEFAULT_QUOTA_SPENT_THRESHOLD },
    now: deps.now,
    schedule: (work, delay) => {
      const timer = setTimeout(work, delay)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    refreshCatalogAfterMutation: () => deps.catalog.refreshAfterMutation(),
    install: (capability) => capabilities.install(capability),
    retire: (id, generation) => {
      const capability = capabilities.available(id)
      if (capability?.generation === generation) capabilities.invalidate(id)
    },
    warn: (message) => deps.logger.warn(message, { component: "recovery" }),
  })
  const capabilities = createRecoveryCapabilities(coordinator.bootId, (id) => {
    const account = held.get(id)
    const recovery = account?.snapshot.recovery
    return account === undefined || recovery === undefined || recovery.state !== "issued"
      ? undefined
      : {
          lifecycleVersion: account.lifecycleVersion,
          authMaterial: account.authMaterial,
          status: account.snapshot.status,
          generation: recovery.generation,
          recoveryRevision: recovery.revision,
        }
  })
  const access = createRecoveryAccess({
    health: deps.health,
    catalog: deps.catalog,
    readAccount: (id) => held.get(id),
    coordinator,
    capabilities,
    now: deps.now,
    retryAfterMs: deps.config.retryAfterMs,
    quotaStaleAfterMs: deps.config.quotaStaleAfterMs,
  })
  return {
    repository,
    coordinator,
    capabilities,
    access,
    reconcile(accounts: readonly RoutableAccount[]) {
      const next = new Map(accounts.map((account) => [account.id, account]))
      for (const id of held.keys()) if (!next.has(id)) access.forget(id)
      held = next
    },
  }
}
