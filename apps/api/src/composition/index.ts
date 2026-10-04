import { createCredentialCipherFromEnv } from "../services/crypto/fromEnv"
import { createAdminPlane } from "./admin"
import { createCliResources } from "./cli-resources"
import { createRequestServices } from "./request-services"
import { assembleRuntimeLifecycle } from "./runtime-lifecycle"
import { createRuntimeRepositories } from "./runtime-repositories"
import { createRuntimeScheduler } from "./runtime-scheduler"
import { createRuntimeTelemetry } from "./runtime-telemetry"
import type { Runtime, RuntimeDeps } from "./runtime-types"
import { createWarmState } from "./warm-state"

export type { Runtime, RuntimeDeps } from "./runtime-types"

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { env, database, logger } = deps
  const cipher = createCredentialCipherFromEnv(env)
  const now = (): Date => new Date()
  const repositories = createRuntimeRepositories(deps)
  const warm = createWarmState(deps, repositories, now)
  const cli = createCliResources(deps, now)
  const telemetry = createRuntimeTelemetry(deps, repositories, warm, cli, now)
  const request = createRequestServices(deps, repositories, warm, cli, telemetry, cipher, now)
  const {
    accounts,
    refreshLock,
    keys,
    pools,
    auditEvents,
    oauthStates,
    adminCredentials,
    scheduledTasks,
    priceOverrides,
  } = repositories
  const {
    catalog,
    health,
    prices,
    recoveryComponents,
    sdkQuota,
    quotaWriter,
    statusWriter,
    modelCatalogStore,
  } = warm
  const { ownership, ownershipConfig, sdkConcurrency, credentialFreshness, configDirs } = cli
  const { usageGauge, adminSessions, metrics } = telemetry
  const {
    backgroundStartGuard,
    sessionStore,
    refreshSubscriptionModels,
    verifier,
    limiter,
    activeRequests,
    dispatcher,
  } = request
  // --- admin plane ----------------------------------------------------------
  // Assembled next door, in `composition/admin.ts`: this file owns the process, that one owns the
  // console's API surface. The two things it needs from here are the warm state a console write
  // must invalidate, and the price book a price edit must refresh.
  const { services: admin, refresher } = createAdminPlane({
    backgroundStartGuard,
    ownership: { manager: ownership, config: ownershipConfig },
    accountDeletionCommitted: async (id) => {
      health.reset(id)
      const results = await Promise.allSettled([
        sessionStore.invalidateAccount(id),
        catalog.refreshAfterMutation(),
      ])
      for (const result of results) if (result.status === "rejected") throw result.reason
    },
    env,
    logger,
    now,
    database,
    accounts,
    refreshLock,
    recovery: recoveryComponents,
    keys,
    pools,
    auditEvents,
    oauthStates,
    adminCredentials,
    scheduledTasks,
    priceOverrides,
    cipher,
    catalog,
    health,
    prices,
    sdkConcurrency,
    // The same refresh-window gate the dispatch path takes: "Test now" spawns against the same
    // config dir, so it has to queue behind a refresh exactly as a real turn does.
    credentialFreshness,
    // The same instance the dispatch path ingests into, so "Test now" and a real request write one
    // account's quota state to one place.
    sdkQuota,
    // The same gauge the dispatch path reads, so a "Test now" turn also answers "how full".
    usageGauge,
    configDirs,
    // The connect flow's login-completion hook: a subscription lists its models the moment it is
    // connected, through the same refresh the hourly sweep runs.
    refreshSubscriptionModels,
    sessionStore: adminSessions,
    coherence: {
      refreshCatalog: () => catalog.refreshAfterMutation(),
      // Editing authorization does not reset a key's already-spent rate-limit window.
      invalidateKey: (keyId: string) => verifier.invalidate(keyId),
      forgetKey: (keyId: string) => {
        verifier.invalidate(keyId)
        limiter.forget(keyId)
      },
    },
  })

  const { scheduler } = createRuntimeScheduler(
    deps,
    repositories,
    warm,
    cli,
    telemetry,
    request,
    admin,
    now,
  )
  const { lifecycle } = assembleRuntimeLifecycle(
    deps,
    repositories,
    warm,
    cli,
    telemetry,
    request,
    admin,
    refresher,
    scheduler,
  )
  return {
    admin,
    verifier,
    dispatcher,
    catalog,
    health,
    sdkQuota,
    quotaWriter,
    statusWriter,
    models: modelCatalogStore,
    prices,
    scheduler,
    metrics,
    start: lifecycle.start,
    closeAdmission: () => activeRequests.closeAdmission(),
    stop: lifecycle.stop,
  }
}
