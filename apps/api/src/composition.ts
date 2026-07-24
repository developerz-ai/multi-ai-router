import {
  createAccountRepository,
  createApiKeyRepository,
  createAuditRepository,
  createPoolRepository,
  createUsageRecordRepository,
  type Database,
} from "@multi-ai-router/db"
import type { Env } from "./config/env"
import type { Logger } from "./logging/logger"
import { createAccountsService, createRecheckService } from "./services/accounts"
import {
  createAuditRecorder,
  withCatalogRefresh,
  withKeyInvalidation,
  withPoolCatalogRefresh,
} from "./services/admin"
import { adminAuthConfigFromEnv, createAdminAuthService } from "./services/admin-auth"
import { createRoutingCatalog, loadCatalog, type RoutingCatalogStore } from "./services/catalog"
import { createCredentialCipherFromEnv } from "./services/crypto/fromEnv"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
  createScopeLoader,
  type Dispatcher,
  type HealthStore,
  type RouterKeyVerifier,
} from "./services/dataplane"
import { createKeysService } from "./services/keys"
import { createPoolsService } from "./services/pools"
import { createUsageRecorder, toUsageRecordRow, type UsageRecorder } from "./services/usage"
import type { AdminServices } from "./types"

/**
 * The composition root: every long-lived object in the process is constructed
 * here, exactly once, and injected downward.
 *
 * It exists so the two things that must be true of this system can be *seen* in
 * one file rather than inferred from twenty:
 *
 * 1. **Nothing on the request path touches Postgres.** The catalog is warm, the
 *    key cache is in memory, and usage writes are queued and flushed off-path.
 *    A repository handed to a data-plane object is always a background caller.
 * 2. **The two credential planes never meet.** The admin services and the data
 *    plane are built from the same repositories but are wired into disjoint
 *    routers with disjoint guards.
 *
 * Wiring is separated from `createApp` because `createApp` is a pure factory
 * that a test calls with stubs. This function is the production wiring, and it
 * is the only place a `Database` becomes a service.
 */

export interface RuntimeDeps {
  readonly env: Env
  readonly database: Database
  readonly logger: Logger
}

export interface Runtime {
  readonly admin: AdminServices
  readonly verifier: RouterKeyVerifier
  readonly dispatcher: Dispatcher
  readonly catalog: RoutingCatalogStore
  readonly health: HealthStore
  /** Loads the catalog and starts the background writers. Awaited before the listener opens. */
  start(): Promise<void>
  /** Flushes what is queued and stops the timers. */
  stop(): Promise<void>
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { env, database, logger } = deps
  const cipher = createCredentialCipherFromEnv(env)
  const now = (): Date => new Date()

  const accounts = createAccountRepository(database)
  const keys = createApiKeyRepository(database)
  const pools = createPoolRepository(database)
  const audit = createAuditRecorder(createAuditRepository(database))
  const usageRecords = createUsageRecordRepository(database)

  // --- warm state -----------------------------------------------------------
  const health = createHealthStore()
  const catalog = createRoutingCatalog({
    load: () => loadCatalog({ accounts, pools }),
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })

  const usage: UsageRecorder = createUsageRecorder(
    {
      write: async (batch) => {
        await usageRecords.insertMany(batch.map(toUsageRecordRow))
      },
    },
    {
      maxQueued: env.dataPlane.usageQueueMax,
      batchSize: env.dataPlane.usageBatchSize,
      flushIntervalMs: env.dataPlane.usageFlushIntervalMs,
    },
  )

  // --- data plane -----------------------------------------------------------
  const verifier = createRouterKeyVerifier({
    repository: keys,
    cipher,
    loadScope: createScopeLoader(async (apiKeyId) => {
      const [poolRows, accountRows] = await Promise.all([
        keys.listPoolTargets(apiKeyId),
        keys.listAccountTargets(apiKeyId),
      ])
      return {
        poolIds: poolRows.map((row) => row.poolId),
        accountIds: accountRows.map((row) => row.accountId),
      }
    }),
    cache: {
      maxEntries: env.dataPlane.keyCacheMax,
      ttlMs: env.dataPlane.keyCacheTtlSeconds * 1_000,
      negativeTtlMs: env.dataPlane.keyCacheNegativeTtlSeconds * 1_000,
    },
    // A write, so it is fired and not awaited: `lastUsedAt` is reporting, and a
    // request must never wait on it.
    onVerified: (key) => {
      void keys.touchLastUsed(key.id, now()).catch((error: unknown) => {
        logger.warn("failed to stamp key last-used", {
          component: "dataplane",
          keyId: key.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      })
    },
  })

  const dispatcher = createDispatcher({
    catalog,
    health,
    cipher,
    usage,
    logger,
    options: {
      failover: { maxAttempts: env.failover.maxAttempts },
      upstreamTimeoutMs: env.failover.upstreamTimeoutMs,
    },
  })

  // --- admin plane ----------------------------------------------------------
  //
  // The CRUD services are plain and know nothing about caches; the decorators in
  // `services/admin/coherence.ts` make a write take effect on the request path
  // before the response is written. Without them an account disabled in the
  // console keeps routing, and a revoked key keeps authenticating, until a TTL
  // expires.
  const coherence = {
    refreshCatalog: () => catalog.refresh(),
    invalidateKey: (keyId: string) => verifier.invalidate(keyId),
  }

  const admin: AdminServices = {
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
      }),
    }),
    accounts: withCatalogRefresh(
      createAccountsService({ accounts, keys, cipher, audit, now }),
      coherence,
    ),
    pools: withPoolCatalogRefresh(
      createPoolsService({ pools, accounts, keys, audit, now }),
      coherence,
    ),
    keys: withKeyInvalidation(
      createKeysService({ keys, pools, accounts, cipher, audit, now }),
      coherence,
    ),
    // "Re-check now": clears the breaker marks so the next real request probes the
    // account, rather than sending a synthetic one the provider would still bill.
    recheck: createRecheckService({
      accounts,
      health,
      cooldownSeconds: env.accountRecheckCooldownSeconds,
      now,
    }),
  }

  return {
    admin,
    verifier,
    dispatcher,
    catalog,
    health,
    start: async () => {
      // Awaited: serving a request against an empty catalog would look exactly
      // like a deployment with no accounts configured.
      await catalog.refresh()
      catalog.start()
      usage.start()
      logger.info("runtime ready", {
        component: "runtime",
        accounts: catalog.accounts().length,
        pools: catalog.pools().length,
      })
    },
    stop: async () => {
      catalog.stop()
      await usage.stop()
    },
  }
}
