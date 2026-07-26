import {
  type AccountRepository,
  type ApiKeyRepository,
  type AuditRepository,
  createUsageReadRepository,
  createUsageRecentRepository,
  type Database,
  type OauthStateRepository,
  type PoolRepository,
  type PriceOverrideRepository,
  type ScheduledTaskRepository,
  type UsageDailyRepository,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import { createSdkTestProbe, type SdkConcurrency } from "../providers"
import type { AccountConfigDirs } from "../providers/claude-sdk/config-dir"
import { scheduledTaskIntervals } from "../scheduler"
import {
  type CredentialRefresher,
  claudeCliFromEnv,
  connectFromEnv,
  createAccountsService,
  createDiscoverModelsService,
  createRecheckService,
  createTestNowService,
  refresherFromEnv,
  withAvailability,
} from "../services/accounts"
import {
  type CoherenceHooks,
  createAuditRecorder,
  withCatalogRefresh,
  withKeyInvalidation,
  withPoolCatalogRefresh,
} from "../services/admin"
import { adminAuthConfigFromEnv, createAdminAuthService } from "../services/admin-auth"
import type { RoutingCatalogStore } from "../services/catalog"
import type { PriceBook } from "../services/cost"
import type { CredentialCipher } from "../services/crypto/cipher"
import type { HealthStore } from "../services/dataplane"
import { createKeysService } from "../services/keys"
import { createPoolsService } from "../services/pools"
import { createSettingsService } from "../services/settings"
import { catalogLabels, createUsageService } from "../services/usage-read"
import type { AdminServices } from "../types"

/**
 * The admin plane's assembly, split from the composition root because it changes for a different
 * reason: the root owns *this process* — its warm caches, its background timers, its start and stop
 * ordering — while everything here is the shape of the console's API surface.
 *
 * Two rules hold across the whole bundle, and both are why it is built in one place rather than per
 * route:
 *
 * 1. **A CRUD service knows nothing about caches.** The `services/admin/coherence.ts` decorators
 *    make an admin write take effect on the request path *before* the response is written. Without
 *    them, an account disabled in the console keeps routing and a revoked key keeps authenticating
 *    until a TTL ends.
 * 2. **The console reaches into the data plane exactly twice, on purpose.** `recheck` clears an
 *    account's breaker marks and the settings service refreshes the price book. Neither can touch a
 *    request in flight.
 */

export interface AdminPlaneDeps {
  readonly env: Env
  readonly logger: Logger
  readonly now: () => Date
  /** Read-only repositories the usage screen builds its own reader from. */
  readonly database: Database
  readonly accounts: AccountRepository
  readonly keys: ApiKeyRepository
  readonly pools: PoolRepository
  readonly auditEvents: AuditRepository
  readonly oauthStates: OauthStateRepository
  readonly usageDaily: UsageDailyRepository
  readonly scheduledTasks: ScheduledTaskRepository
  readonly priceOverrides: PriceOverrideRepository
  readonly cipher: CredentialCipher
  readonly catalog: RoutingCatalogStore
  readonly health: HealthStore
  /** Refreshed after a price edit, so the console is read-after-write consistent on cost. */
  readonly prices: PriceBook
  /**
   * The replica's `claude` subprocess ceiling, as the composition root built it. Passed in rather
   * than created here because "Test now" spawns the same process the dispatch path does, and one
   * memory budget takes one gate — see `providers/claude-sdk/test-probe.ts`.
   */
  readonly sdkConcurrency: SdkConcurrency
  /**
   * One isolated `CLAUDE_CONFIG_DIR` per subscription account, as the composition root built it.
   * Passed in for the same reason the gate above is: the scheduler's reaper sweeps the very volume
   * this plane provisions on, and two instances could be rooted at two different places.
   */
  readonly configDirs: AccountConfigDirs
  readonly coherence: CoherenceHooks
}

export interface AdminPlane {
  readonly services: AdminServices
  /**
   * Exposed for boot and shutdown ordering. It is built here because the connect flow hands it
   * every freshly written credential, and it must be armed before the listener opens.
   */
  readonly refresher: CredentialRefresher
}

export function createAdminPlane(deps: AdminPlaneDeps): AdminPlane {
  const { env, logger, now, accounts, keys, cipher, catalog, health, configDirs } = deps
  const audit = createAuditRecorder(deps.auditEvents)

  // Both halves of running the `claude` binary against an account's directory, and every login flow
  // behind the one service the admin plane mounts.
  const cli = claudeCliFromEnv({ accounts, configDirs, audit, env, logger, now })
  // Expiry-driven per account, never a poll (non-negotiable 13); built before `connect` needs it.
  const refresher = refresherFromEnv({ accounts, cipher, audit, env, logger, now, catalog })
  const connect = connectFromEnv({
    cli,
    accounts,
    oauthStates: deps.oauthStates,
    cipher,
    audit,
    env,
    now,
    refresher,
  })

  // "Re-check now": clears the breaker marks so the next real request probes the account rather
  // than sending a synthetic one the provider would still bill. Built before the services, because
  // the accounts read overlays its last-checked timestamps.
  const recheck = createRecheckService({
    accounts,
    health,
    audit,
    auth: cli.authProbe,
    cooldownSeconds: env.accountRecheckCooldownSeconds,
    now,
  })

  // "Test now": one real, opt-in completion against one account. Its own cooldown and its own
  // audit kind — see `services/accounts/test-now.ts` for why it is never folded into `recheck`.
  const testNow = createTestNowService({
    accounts,
    cipher,
    audit,
    cooldownSeconds: env.accountTestNowCooldownSeconds,
    timeoutMs: env.failover.upstreamTimeoutMs,
    now,
    // Re-resolved per call inside the probe itself (`resolveClaudeCli`), for the same reason
    // `claudeCliFromEnv` re-resolves rather than resolving once at boot.
    sdkProbe: createSdkTestProbe({
      cliPathOverride: env.claudeCliPath,
      concurrency: deps.sdkConcurrency,
    }),
  })

  const accountsService = createAccountsService({ accounts, keys, cipher, configDirs, audit, now })
  // Decorated once, and shared: "Discover models" writes through the same service the route does,
  // so its write refreshes the warm catalog exactly like an operator's edit would.
  const decoratedAccounts = withAvailability(withCatalogRefresh(accountsService, deps.coherence), {
    catalog,
    health,
    recheck,
    now,
  })

  // "Discover models": one GET at the provider's own listing, written into `supportedModels`. No
  // cooldown and no confirmation — it bills nothing (`services/accounts/discover-models.ts`).
  const discoverModels = createDiscoverModelsService({
    accounts,
    write: decoratedAccounts,
    cipher,
    audit,
    timeoutMs: env.failover.upstreamTimeoutMs,
  })

  return {
    refresher,
    services: {
      auth: createAdminAuthService({
        env,
        // The env layer speaks minutes and hours; the service speaks seconds.
        // `adminAuthConfigFromEnv` is the single conversion, so the two never drift.
        config: adminAuthConfigFromEnv({
          adminSessionIdleMinutes: env.adminAuth.sessionIdleMinutes,
          adminSessionAbsoluteHours: env.adminAuth.sessionAbsoluteHours,
          adminLoginMaxAttempts: env.adminAuth.loginMaxAttempts,
          adminLoginAttemptWindowMinutes: env.adminAuth.loginAttemptWindowMinutes,
          adminLoginLockoutMinutes: env.adminAuth.loginLockoutMinutes,
          adminSessionSlideFraction: env.adminAuth.sessionSlideFraction,
        }),
        audit,
      }),
      // Two decorators in the order they must run: `withCatalogRefresh` makes a write land on the
      // request path, `withAvailability` answers a read with what the router currently observes
      // rather than with the row the operator last wrote.
      accounts: decoratedAccounts,
      pools: withPoolCatalogRefresh(
        createPoolsService({ pools: deps.pools, accounts, keys, audit, now }),
        deps.coherence,
      ),
      keys: withKeyInvalidation(
        createKeysService({ keys, pools: deps.pools, accounts, cipher, audit, now }),
        deps.coherence,
      ),
      usage: createUsageService({
        usage: createUsageReadRepository(deps.database),
        recent: createUsageRecentRepository(deps.database),
        daily: deps.usageDaily,
        scheduledTasks: deps.scheduledTasks,
        labels: catalogLabels({ keys, catalog }),
        now,
      }),
      settings: createSettingsService({
        prices: deps.priceOverrides,
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
        onPricesChanged: () => deps.prices.refresh(),
      }),
      recheck,
      testNow,
      discoverModels,
      connect,
    },
  }
}
