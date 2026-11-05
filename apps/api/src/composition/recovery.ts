import {
  type AccountRepository,
  createRecoveryRepository,
  type Database,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import type { TestNowService } from "../services/accounts/test-now"
import type { RoutingCatalogStore } from "../services/catalog"
import type { HealthStore } from "../services/dataplane/health"
import { createRecoveryAccess } from "../services/dataplane/recovery-access"
import { createRecoveryCapabilities } from "../services/dataplane/recovery-capability"
import { createRecoveryProbe, type RecoveryProbeSend } from "../services/dataplane/recovery-probe"
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
  /** Which model each provider's recovery probe asks for (`IDLE_PROBE_MODELS`). */
  probeModels: Readonly<Record<string, string>>
  quotaSpentThreshold?: number
}) {
  const quotaSpentThreshold = deps.quotaSpentThreshold ?? DEFAULT_QUOTA_SPENT_THRESHOLD
  let held = new Map(deps.catalog.accounts().map((account) => [account.id, account]))
  const repository = createRecoveryRepository(deps.database)
  const schedule = (work: () => void, delay: number) => {
    const timer = setTimeout(work, delay)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
  const warn = (message: string) => deps.logger.warn(message, { component: "recovery" })
  const coordinator = createRecoveryCoordinator({
    repository,
    accounts: deps.accounts,
    config: { ...deps.config, quotaSpentThreshold },
    now: deps.now,
    schedule,
    refreshCatalogAfterMutation: () => deps.catalog.refreshAfterMutation(),
    install: (capability) => {
      if (!capabilities.install(capability)) return false
      probe.offer(capability)
      return true
    },
    retire: (id, generation) => {
      const capability = capabilities.available(id)
      if (capability?.generation === generation) capabilities.invalidate(id)
    },
    reopen: () => probe.reopen(),
    warn,
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
    quotaSpentThreshold,
  })
  const probe = createRecoveryProbe({
    access,
    accounts: () => [...held.values()],
    readAccount: (id) => held.get(id),
    available: (id) => capabilities.available(id),
    health: deps.health,
    models: deps.probeModels,
    graceMs: deps.config.requestWaitMs,
    quotaSpentThreshold,
    schedule,
    now: deps.now,
    warn,
  })
  return {
    repository,
    coordinator,
    capabilities,
    access,
    /** `attach` the transport once the admin plane has built it (`composition/index.ts`). */
    probe,
    reconcile(accounts: readonly RoutableAccount[]) {
      const next = new Map(accounts.map((account) => [account.id, account]))
      for (const id of held.keys())
        if (!next.has(id)) {
          access.forget(id)
          probe.forget(id)
        }
      held = next
    },
  }
}

/**
 * The recovery probe spends the admin plane's own "Test now", exactly as the idle sweep does: one
 * transport, one per-account cooldown, one audit kind. `confirmed`: a Claude subscription's probe is
 * the one turn its first client request would otherwise have spent, once per recovery generation.
 */
export function recoveryProbeSender(testNow: Pick<TestNowService, "test">): RecoveryProbeSend {
  return async (accountId, model, startGuard) => {
    const result = await testNow.test(accountId, {
      model,
      confirmed: true,
      recoveryStartGuard: startGuard,
    })
    // A refusal (unknown id, unimplemented provider, declined admission) sent nothing.
    return result.ok ? result.value : { tested: false }
  }
}
