import {
  type AccountRepository,
  type ApiKeyRepository,
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
import { createReachability } from "../services/dataplane/recovery-reach"
import type { RoutableAccount } from "../services/dataplane/types"
import { createRecoveryCoordinator } from "../services/recovery"
import { DEFAULT_QUOTA_SPENT_THRESHOLD } from "../services/routing"

export function createRecoveryComponents(deps: {
  database: Database
  accounts: AccountRepository
  health: HealthStore
  catalog: RoutingCatalogStore
  /** Key scopes, read off-path only when an account is due a reopen. */
  keys: Pick<ApiKeyRepository, "list" | "listTargetsForKeys">
  /** The catalog's staleness bound (`CATALOG_REFRESH_SECONDS`), reused for key reach. */
  reachTtlMs: number
  config: Env["recovery"]
  logger: Logger
  now: () => Date
  /** Each provider's fallback probe model (`IDLE_PROBE_MODELS`), for accounts declaring none. */
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
    issuing: () => coordinator.issuing(),
    reach: createReachability({
      keys: deps.keys,
      pools: () => deps.catalog.pools(),
      now: deps.now,
      ttlMs: deps.reachTtlMs,
    }),
    health: deps.health,
    models: deps.probeModels,
    graceMs: deps.config.requestWaitMs,
    quotaSpentThreshold,
    schedule,
    now: deps.now,
    log: deps.logger.child({ component: "recovery-probe" }),
  })
  return {
    repository,
    coordinator,
    capabilities,
    access,
    /** `attach` the transport once the admin plane has built it (`composition/index.ts`). */
    probe,
    /** The shutdown signal: no new permit, and no grace timer left to spend one. */
    closeIssuance() {
      coordinator.closeIssuance()
      probe.close()
    },
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
 * transport, one audit kind (`trigger: router_recovery`). Not its press cooldown: the permit already
 * bounds the probe to one per generation, and a 120 s operator cooldown against a 30 s recovery
 * cooldown would let the permit expire unspent, the defect this probe exists to close.
 * `confirmed`: a Claude subscription's probe is the one turn its first client request would
 * otherwise have spent.
 */
export function recoveryProbeSender(testNow: Pick<TestNowService, "test">): RecoveryProbeSend {
  return async ({ accountId, model, startGuard, rateLimitSink }) => {
    const result = await testNow.test(accountId, {
      model,
      confirmed: true,
      recovery: { startGuard, rateLimitSink },
    })
    if (!result.ok)
      // The permit's own guard refused (a client took it) versus a transport that cannot serve.
      return result.failure.code === "background_admission_refused"
        ? { kind: "declined" }
        : { kind: "refused", reason: result.failure.message }
    const value = result.value
    if (!value.tested) return { kind: "refused", reason: "test now declined the press" }
    return {
      kind: "answered",
      ok: value.outcome === "ok",
      message: value.message ?? "",
      ...(value.failureKind === undefined ? {} : { failureKind: value.failureKind }),
    }
  }
}
