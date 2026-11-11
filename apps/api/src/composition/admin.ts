import {
  createAdminMutationRepository,
  createUsageHistoryRepository,
  createUsageReadRepository,
  createUsageRecentRepository,
  createUsageReportRepository,
} from "@multi-ai-router/db"
import { usageSnapshotStatementTimeoutMs } from "../config/usage-snapshot"
import { createCredentialMetadataReader, createSdkTestProbe } from "../providers"
import { scheduledTaskIntervals } from "../scheduler"
import {
  claudeCliFromEnv,
  connectFromEnv,
  createAccountsService,
  createCredentialPark,
  createDiscoverModelsService,
  createRecheckService,
  createTestNowService,
  liveHealthCheck,
  refreshErrorLogger,
  refresherFromEnv,
  withAvailability,
  withCredentialMetadata,
} from "../services/accounts"
import { createLastLoginLookup } from "../services/accounts/last-login"
import { loginLifetimePolicy } from "../services/accounts/login-lifetime"
import { createAuditRecorder, keyMutationCommitted } from "../services/admin"
import { createKeysService } from "../services/keys"
import { createPoolsService } from "../services/pools"
import { createSettingsService } from "../services/settings"
import { accountProviders, catalogLabels, createUsageService } from "../services/usage-read"
import { createAdminAuth } from "./admin-auth"
import type { AdminPlane, AdminPlaneDeps } from "./admin-types"
import { ownedCredentialMetadataReader } from "./credential-ownership"
import { createUsageReportDelivery, createUsageReports } from "./usage-reports"

export type { AdminPlane, AdminPlaneDeps } from "./admin-types"

/**
 * The admin plane's assembly, split from the composition root because it changes for a different
 * reason: the root owns *this process* — its warm caches, its background timers, its start and stop
 * ordering — while everything here is the shape of the console's API surface.
 *
 * Two rules hold across the whole bundle, and both are why it is built in one place rather than per
 * route:
 *
 * 1. **A CRUD service knows nothing about caches.** Committed-mutation callbacks and account
 *    decorators apply writes to the warm caches before the response. Key/pool writes and audits
 *    commit atomically; their callbacks run before response mapping.
 * 2. **The console reaches into the data plane exactly twice, on purpose.** `recheck` clears an
 *    account's breaker marks and the settings service refreshes the price book. Neither can touch a
 *    request in flight.
 */

export function createAdminPlane(deps: AdminPlaneDeps): AdminPlane {
  const { env, logger, now, accounts, keys, keyTombstones, cipher, catalog, health, configDirs } =
    deps
  const audit = createAuditRecorder(deps.auditEvents)
  const mutations = createAdminMutationRepository(deps.database)

  // Both halves of running the `claude` binary against an account's directory, and every login flow
  // behind the one service the admin plane mounts.
  const cli = claudeCliFromEnv({
    ownership: deps.ownership,
    accounts,
    configDirs,
    audit,
    env,
    logger,
    now,
    // A completed login lifts the same live verdict Re-check does — see `connect/claude.ts`.
    health,
    refreshCatalog: deps.coherence.refreshCatalog,
    // A freshly connected subscription lists its models at once, turn-free (`services/models`).
    // Fire-and-forget: the refresh never throws, and a login does not wait on a catalog.
    onConnected: (accountId) => {
      void deps.refreshSubscriptionModels(accountId)
    },
  })
  // Expiry-driven per account, never a poll (non-negotiable 13); built before `connect` needs it.
  const refresher = refresherFromEnv({
    accounts,
    cipher,
    audit,
    env,
    logger,
    now,
    catalog,
    refreshLock: deps.refreshLock,
  })
  const refreshFailed = refreshErrorLogger(logger)
  const connect = connectFromEnv({
    cli,
    accounts,
    oauthStates: deps.oauthStates,
    cipher,
    audit,
    env,
    now,
    refresher,
    refreshCatalogAfterMutation: deps.coherence.refreshCatalog,
    logger,
  })

  // "Re-check now": clears the breaker marks and demands a recovery permit, which the next real
  // request spends or, failing one inside the request wait budget, the router's own probe
  // (`dataplane/recovery-probe.ts`). Built before the services, because the accounts read overlays
  // its last-checked timestamps.
  const recheck = createRecheckService({
    accounts,
    audit,
    auth: cli.authProbe,
    // Clearing a stored `exhausted` is a write to a row the warm catalog is serving, so it joins
    // the same read-after-write guarantee every other admin write has.
    refreshCatalog: deps.coherence.refreshCatalog,
    cooldownSeconds: env.accountRecheckCooldownSeconds,
    operatorCheckLeaseMs: env.recovery.operatorCheckLeaseMs,
    recovery: deps.recovery.repository,
    onRecoveryRequested: (accountId) => deps.recovery.coordinator.demand(accountId),
    // A re-check of an account the router already sees as healthy settles at once instead of
    // issuing a recovery permit that holds live traffic behind it (03.1).
    isLiveHealthy: liveHealthCheck({ catalog, health, now }),
    recheckAllConcurrency: env.accountRecheckAllConcurrency,
    // `retryParked` answers `not-refreshable` for a Claude subscription: its token is the SDK's.
    onParkedRecheck: (accountId) => {
      refresher
        .retryParked(accountId)
        .catch((error) => refreshFailed("re-checked refresh raised", error, accountId))
    },
  })

  // "Test now": one real, opt-in completion against one account. Its own cooldown and its own
  // audit kind — see `services/accounts/test-now.ts` for why it is never folded into `recheck`.
  const testNow = createTestNowService({
    createBackgroundStartGuard: deps.backgroundStartGuard,
    accounts,
    cipher,
    audit,
    cooldownSeconds: env.accountTestNowCooldownSeconds,
    timeoutMs: env.failover.upstreamTimeoutMs,
    now,
    // Re-resolved per call inside the probe itself (`resolveClaudeCli`), for the same reason
    // `claudeCliFromEnv` re-resolves rather than resolving once at boot.
    sdkProbe: createSdkTestProbe({
      ownerLaunch: deps.ownership.manager.ownerLaunch,
      cliPathOverride: env.claudeCliPath,
      concurrency: deps.sdkConcurrency,
      freshness: deps.credentialFreshness,
      ...(deps.usageGauge === undefined ? {} : { usageGauge: deps.usageGauge }),
    }),
    // The turn is billed either way; this is what makes it also answer "how much is left" — and
    // `health` is what makes that answer visible, since the console reads a health snapshot rather
    // than the quota store.
    quota: deps.sdkQuota,
    health,
    log: logger,
    reasonMaxChars: env.logReasonMaxChars,
  })

  const accountsService = createAccountsService({
    revokeDeletedAccount: async (account) => {
      connect.revoke(account.id)
      await deps.ownership.manager.revokeDeletedAccount(account)
    },
    deletionCommitted: deps.accountDeletionCommitted,
    cleanupDeletedAccount: deps.ownership.manager.cleanupDeletedAccount,
    accounts,
    keys,
    cipher,
    configDirs,
    audit,
    now,
    mutationCommitted: () => deps.coherence.refreshCatalog(),
  })
  // Decorated once, and shared: "Discover models" writes through the same service the route does,
  // so its write refreshes the warm catalog exactly like an operator's edit would.
  const availableAccounts = withAvailability(accountsService, {
    catalog,
    health,
    now,
    // Reads how many tokens the router itself recorded inside each configured window's span, so
    // the console can draw a bar where the provider reports no utilization. One query, and only
    // for accounts whose operator set a ceiling.
    usage: createUsageReadRepository(deps.database),
  })
  // Outermost, so a dead login it parks is the status the read returns, not the warm catalog's
  // stale `active`.
  const decoratedAccounts = withCredentialMetadata(availableAccounts, {
    accounts,
    reader: ownedCredentialMetadataReader(
      createCredentialMetadataReader(),
      deps.ownership.manager,
      configDirs.root,
    ),
    configDirs,
    ttlMs: env.adminCredentialMetadataTtlSeconds * 1_000,
    now,
    park: createCredentialPark({ accounts, audit, refreshCatalog: deps.coherence.refreshCatalog }),
    logger,
    lifetime: {
      lastLogins: createLastLoginLookup(deps.auditEvents),
      policy: loginLifetimePolicy(env.claudeLogin),
      warnDays: env.claudeLogin.renewalWarnDays,
    },
  })

  // "Discover models": one GET at the provider's own listing, written into `supportedModels`. No
  // cooldown and no confirmation — it bills nothing (`services/accounts/discover-models.ts`).
  const discoverModels = createDiscoverModelsService({
    accounts,
    write: decoratedAccounts,
    cipher,
    audit,
    timeoutMs: env.failover.upstreamTimeoutMs,
    maxResponseBytes: env.modelListingMaxBytes,
    log: logger,
    reasonMaxChars: env.logReasonMaxChars,
  })

  return {
    refresher,
    services: {
      auth: createAdminAuth(deps, audit),
      // Two decorators in the order they must run: `withCatalogRefresh` makes a write land on the
      // request path, `withAvailability` answers a read with what the router currently observes
      // rather than with the row the operator last wrote.
      accounts: decoratedAccounts,
      pools: createPoolsService({
        pools: deps.pools,
        accounts,
        now,
        mutations,
        onCommitted: () => deps.coherence.refreshCatalog(),
      }),
      keys: createKeysService({
        keys,
        cipher,
        audit,
        now,
        mutations,
        onCommitted: (id, kind) => keyMutationCommitted(deps.coherence, id, kind),
      }),
      usage: createUsageService({
        history: createUsageHistoryRepository(deps.database, {
          snapshotStatementTimeoutMs: usageSnapshotStatementTimeoutMs(env),
        }),
        recent: createUsageRecentRepository(deps.database),
        labels: catalogLabels({ keys, tombstones: keyTombstones, catalog }),
        providers: accountProviders(catalog),
        ...env.usageRead,
        now,
      }),
      usageReports: createUsageReports({ ...deps, now }),
      usageReportDelivery: createUsageReportDelivery({
        database: deps.database,
        env,
        audit,
        now,
      }),
      settings: createSettingsService({
        prices: deps.priceOverrides,
        // One read for the weekly-report panel (issue #229): the newest delivery instant. The
        // webhook boolean comes from env; the URL is a credential and never reaches this service.
        usageReports: createUsageReportRepository(deps.database),
        priceAccounts: () =>
          catalog.accounts().map((account) => ({
            id: account.id,
            label: account.snapshot.label,
            provider: account.driver.provider,
            billing: account.billing,
            models: [
              ...new Set([
                ...(account.snapshot.supportedModels ?? []),
                ...Object.values(account.driver.modelAliases ?? {}),
              ]),
            ],
          })),
        scheduledTasks: deps.scheduledTasks,
        auditEvents: deps.auditEvents,
        audit,
        env,
        // From the registry the scheduler was actually built with, so the health screen cannot
        // judge a task against a cadence this process is not running.
        intervals: scheduledTaskIntervals(env),
        now,
        // Read-after-write on cost: a saved override is pricing requests by the time the console
        // sees the response, the same guarantee the coherence decorators give the catalog.
        onPricesChanged: () => deps.prices.refreshAfterMutation(),
      }),
      recheck,
      testNow,
      // Same instance the re-check button uses — one probe, one `needs_reauth` transition.
      ...(cli.authProbe === undefined ? {} : { authProbe: cli.authProbe }),
      discoverModels,
      connect,
    },
  }
}
