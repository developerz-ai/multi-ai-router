import { createSdkInvoker, createSdkModelLister, createSdkUsageGaugeProbe } from "../providers"
import { fastProfileAvailable } from "../providers/claude-fast/availability"
import { readFastCredential } from "../providers/claude-fast/credential"
import { createFastInvoker } from "../providers/claude-fast/invoker"
import { UpstreamAdmissionRefused } from "../providers/upstream-admission"
import type { createCredentialCipherFromEnv } from "../services/crypto/fromEnv"
import {
  createDispatcher,
  createRateLimiter,
  createRouterKeyVerifier,
  repositoryScopeLoader,
  sessionStoreFromEnv,
  stampLastUsed,
} from "../services/dataplane"
import { createActiveRequestRegistry } from "../services/dataplane/active-requests"
import {
  type CatalogRefreshDeps,
  createSubscriptionModelRefresh,
  refreshAccountCatalog,
} from "../services/models"
import { DEFAULT_QUOTA_SPENT_THRESHOLD } from "../services/routing"
import { createWarmBackgroundStartGuard } from "./background-admission"
import type { createCliResources } from "./cli-resources"
import { dispatchOptionsFromEnv } from "./dispatch-options"
import type { createRuntimeRepositories } from "./runtime-repositories"
import type { createRuntimeTelemetry } from "./runtime-telemetry"
import type { RuntimeDeps } from "./runtime-types"
import type { createWarmState } from "./warm-state"
export function createRequestServices(
  deps: RuntimeDeps,
  repositories: ReturnType<typeof createRuntimeRepositories>,
  warm: ReturnType<typeof createWarmState>,
  cli: ReturnType<typeof createCliResources>,
  telemetry: ReturnType<typeof createRuntimeTelemetry>,
  cipher: ReturnType<typeof createCredentialCipherFromEnv>,
  now: () => Date,
) {
  const { env, logger } = deps
  const { accounts, keys, sessions, modelCatalog } = repositories
  const { recoveryComponents, catalog, health, sdkQuota, prices, modelCatalogStore } = warm
  const { ownership, sdkConcurrency, credentialFreshness } = cli
  const { usageGauge, usage, metrics } = telemetry
  // --- data plane -----------------------------------------------------------
  const verifier = createRouterKeyVerifier({
    repository: keys,
    cipher,
    loadScope: repositoryScopeLoader(keys),
    cache: {
      maxEntries: env.dataPlane.keyCacheMax,
      ttlMs: env.dataPlane.keyCacheTtlSeconds * 1_000,
      negativeTtlMs: env.dataPlane.keyCacheNegativeTtlSeconds * 1_000,
    },
    // Fired, never awaited: `lastUsedAt` is reporting, and a request must not wait on it.
    onVerified: stampLastUsed(keys, logger, now),
  })

  // Per replica by design (`limits.ts`); sized off the key cache — one window per verified key.
  const limiter = createRateLimiter({ maxKeys: env.dataPlane.keyCacheMax })

  // Postgres is the truth, the LRU pair in front of it is the cache. A binding says where a
  // conversation physically lives upstream, so no policy may overrule it and no hash recomputes it.
  const sessionStore = sessionStoreFromEnv({
    env,
    repository: sessions,
    logger,
    now,
    ...(cli.sessionCarrier === undefined ? {} : { carrier: cli.sessionCarrier }),
  })
  let backgroundAdmissionOpen = true
  const backgroundStartGuard = (
    expected: Parameters<typeof createWarmBackgroundStartGuard>[1],
    signal?: AbortSignal,
  ) =>
    createWarmBackgroundStartGuard(
      {
        accounts,
        catalog,
        access: recoveryComponents.access,
        now,
        quotaSpentThreshold: DEFAULT_QUOTA_SPENT_THRESHOLD,
        logger,
        accepting: () => backgroundAdmissionOpen,
      },
      expected,
      signal,
    )

  // The Claude subscription transport, over the semaphore pair above. Its quota store is built
  // with the rest of the warm state, since `HealthStore.reset` has to be able to clear it.
  const invokeSdk = createSdkInvoker({
    ownerLaunch: ownership.ownerLaunch,
    concurrency: sdkConcurrency,
    freshness: credentialFreshness,
    cliPathOverride: env.claudeCliPath,
    usageGauge,
    onIgnoredOption: (detail) =>
      logger.debug("subscription request option dropped", {
        component: "claude-sdk",
        field: detail.field,
        value: detail.value,
      }),
  })
  const fastEnabled = env.claudeFastMode && fastProfileAvailable(env.claudeCliPath)
  if (env.claudeFastMode && !fastEnabled)
    logger.warn("Claude fast mode profile is unverified for this CLI/runtime; using SDK", {
      component: "claude-fast",
    })
  const fastInvoker = fastEnabled
    ? createFastInvoker({
        sdk: invokeSdk,
        concurrency: sdkConcurrency,
        errorMaxBytes: env.failover.upstreamErrorMaxBytes,
        now: () => now().getTime(),
        credential: (accountId, configDir) => {
          if (configDir !== cli.configDirs.pathFor(accountId)) throw new UpstreamAdmissionRefused()
          return ownership.withMetadataOwner(accountId, () => readFastCredential(configDir))
        },
        resolveModel: (accountId, model) => {
          if (model.startsWith("claude-")) return model
          const tag = model.endsWith("[1m]") ? "[1m]" : ""
          const alias = tag ? model.slice(0, -4) : model
          const descriptor = modelCatalogStore.describe(accountId, alias)
          return descriptor?.listingSource === "live" && descriptor.resolvedModel
            ? `${descriptor.resolvedModel}${tag}`
            : null
        },
        onFallback: (reason) =>
          logger.debug("Claude fast mode request uses SDK fallback", {
            component: "claude-fast",
            reason,
          }),
      })
    : undefined
  const usageGaugeProbe = createSdkUsageGaugeProbe({
    ownerLaunch: ownership.ownerLaunch,
    gauge: usageGauge,
    concurrency: sdkConcurrency,
    freshness: credentialFreshness,
    cliPathOverride: env.claudeCliPath,
    // The handshake bound the model lister uses too: a subprocess start, not a model's answer.
    timeoutMs: env.failover.upstreamTimeoutMs,
  })

  // What a Claude subscription can be asked for, read from the Agent SDK's handshake over the same
  // subprocess gate — a subscription has no HTTP listing, and without this a pool of them answers
  // `GET /v1/models` with `data: []` (`providers/claude-sdk/model-list.ts`).
  const sdkModelLister = createSdkModelLister({
    ownerLaunch: ownership.ownerLaunch,
    concurrency: sdkConcurrency,
    freshness: credentialFreshness,
    cliPathOverride: env.claudeCliPath,
    onUnavailable: (reason, detail) =>
      logger.info("subscription model listing unavailable", {
        component: "model-catalog",
        reason,
        ...(detail === "" ? {} : { detail }),
      }),
  })
  // One refresh for both transports, built once so the sweep and the login-completion hook can
  // never disagree about what a refresh is. Free, off the request path, and pointed at
  // `model_catalog` alone — `supported_models`, which gates routing, stays the operator's.
  const catalogRefreshDeps: CatalogRefreshDeps = {
    catalog: modelCatalog,
    cipher,
    timeoutMs: env.failover.upstreamTimeoutMs,
    fetch: (request) => fetch(request),
    subscription: {
      lister: sdkModelLister,
      timeoutMs: env.failover.upstreamTimeoutMs,
      logger: logger.child({ component: "model-catalog" }),
    },
  }
  // For the moment a login completes: refresh that account now and warm the store, so the console
  // and the pool's clients see its models before the sweep's next tick.
  const refreshSubscriptionModels = createSubscriptionModelRefresh({
    accounts,
    refresh: (account, at) => refreshAccountCatalog(catalogRefreshDeps, account, at),
    onRefreshed: () => modelCatalogStore.refreshAfterMutation(),
    logger: logger.child({ component: "model-catalog" }),
    now,
  })

  const activeRequests = createActiveRequestRegistry(env.relayLifetimes)
  const dispatcher = createDispatcher({
    modelMetadata: modelCatalogStore,
    activeRequests,
    recovery: recoveryComponents.access,
    catalog,
    health,
    cipher,
    usage,
    limiter,
    invokeSdk: fastInvoker ?? invokeSdk,
    quota: sdkQuota,
    // Direct HTTP carries each full history; SDK resume claims would serialize unrelated children.
    ...(fastInvoker === undefined ? { sessions: sessionStore } : {}),
    // Synchronous, warm, and the whole reason the book exists: an attempt is priced on the request
    // path, so a lookup that could await a query would put Postgres on it.
    prices: prices.lookup,
    logger,
    onRequest: (sample) => metrics.observeRequest(sample),
    onBindingWait: (milliseconds) => metrics.observeBindingWait(milliseconds),
    // One tested mapping from parsed env to dispatcher behavior — see `dispatch-options.ts`.
    options: dispatchOptionsFromEnv(env),
  })

  return {
    verifier,
    limiter,
    sessionStore,
    backgroundStartGuard,
    invokeSdk,
    usageGaugeProbe,
    catalogRefreshDeps,
    refreshSubscriptionModels,
    activeRequests,
    dispatcher,
    closeBackgroundAdmission: () => {
      backgroundAdmissionOpen = false
    },
  }
}
