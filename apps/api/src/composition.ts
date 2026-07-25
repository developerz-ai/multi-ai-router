import {
  createAccountRepository,
  createApiKeyRepository,
  createAuditRepository,
  createOauthStateRepository,
  createPoolRepository,
  createScheduledTaskRepository,
  createSessionRepository,
  createUsageDailyRepository,
  createUsageReadRepository,
  createUsageRecordRepository,
  type Database,
  type SqlConnection,
} from "@multi-ai-router/db"
import type { Env } from "./config/env"
import type { Logger } from "./logging/logger"
import { createRuntimeMetrics, type RouterMetrics } from "./observability"
import {
  advisoryTaskLock,
  createScheduledTasks,
  createScheduler,
  type Scheduler,
} from "./scheduler"
import { createAccountsService, createRecheckService, withAvailability } from "./services/accounts"
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
  type Dispatcher,
  type HealthStore,
  type RouterKeyVerifier,
  repositoryScopeLoader,
} from "./services/dataplane"
import { createKeysService } from "./services/keys"
import { createPoolsService } from "./services/pools"
import { createUsageRecorder, toUsageRecordRow, type UsageRecorder } from "./services/usage"
import { createUsageService } from "./services/usage-read"
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
  /**
   * The pool behind `database`. One consumer: an advisory lock lives on a
   * *session*, so the scheduler needs a connection it can reserve. No service is
   * ever handed it.
   */
  readonly sql: SqlConnection
  readonly logger: Logger
}

export interface Runtime {
  readonly admin: AdminServices
  readonly verifier: RouterKeyVerifier
  readonly dispatcher: Dispatcher
  readonly catalog: RoutingCatalogStore
  readonly health: HealthStore
  /** Exposed for the admin plane's "run now" and for shutdown ordering; the timers are internal. */
  readonly scheduler: Scheduler
  /** What `GET /metrics` renders. Fed from the usage drain, the scheduler, and per-scrape gauges. */
  readonly metrics: RouterMetrics
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
  const auditEvents = createAuditRepository(database)
  const audit = createAuditRecorder(auditEvents)
  const usageRecords = createUsageRecordRepository(database)
  // Written by the admin-auth and OAuth flows; here only so the sweeps can reach them.
  const sessions = createSessionRepository(database)
  const oauthStates = createOauthStateRepository(database)
  // Shared by the admin read path (closed days) and the rollup task (the writer
  // that puts them there) — one repository, both directions.
  const usageDaily = createUsageDailyRepository(database)
  // The scheduler's run log. The usage read path needs it too, to know which
  // days the rollup has actually closed.
  const scheduledTasks = createScheduledTaskRepository(database)

  // --- warm state -----------------------------------------------------------
  const health = createHealthStore()
  const catalog = createRoutingCatalog({
    load: () => loadCatalog({ accounts, pools }),
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })
  // `usage` is a getter because the recorder below reports *into* this: see `observability/`.
  const metrics = createRuntimeMetrics({ catalog, health, usage: () => usage, logger, now })

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
      onRecord: (record) => metrics.observeUsage(record),
    },
  )

  // --- background work ------------------------------------------------------
  // Every periodic task behind one in-process runner (non-negotiable 13). The lock
  // is bound here and passed as a capability, so nothing below holds a connection.
  const scheduler = createScheduler({
    tasks: createScheduledTasks({
      sessions,
      usageRecords,
      auditEvents,
      apiKeys: keys,
      oauthStates,
      usageDaily,
      accounts,
      scheduledTasks,
      health,
      env,
    }),
    repo: scheduledTasks,
    lock: advisoryTaskLock(deps.sql),
    jitterFraction: env.scheduler.jitterFraction,
    logger,
    now,
    onTick: (result) => metrics.observeTask(result),
  })

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
    onRequest: (sample) => metrics.observeRequest(sample),
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
  // "Re-check now": clears the breaker marks so the next real request probes the account, rather
  // than sending a synthetic one the provider would still bill. Built before the services,
  // because the accounts read overlays its last-checked timestamps.
  const recheck = createRecheckService({
    accounts,
    health,
    cooldownSeconds: env.accountRecheckCooldownSeconds,
    now,
  })

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
    // Two decorators, two concerns, applied in the order they must run: the CRUD service knows
    // nothing about caches or health, `withCatalogRefresh` makes a write land on the request
    // path, and `withAvailability` answers a read with what the router currently observes rather
    // than with the row the operator last wrote.
    accounts: withAvailability(
      withCatalogRefresh(createAccountsService({ accounts, keys, cipher, audit, now }), coherence),
      { catalog, health, recheck, now },
    ),
    pools: withPoolCatalogRefresh(
      createPoolsService({ pools, accounts, keys, audit, now }),
      coherence,
    ),
    keys: withKeyInvalidation(
      createKeysService({ keys, pools, accounts, cipher, audit, now }),
      coherence,
    ),
    // Accounts and pools are named from the warm catalog; keys need the one query, which is
    // unremarkable on the admin plane. A miss means the subject was deleted — the row still
    // renders as "deleted", because spend that happened is still spend.
    usage: createUsageService({
      usage: createUsageReadRepository(database),
      daily: usageDaily,
      scheduledTasks,
      labels: async () => ({
        keys: new Map((await keys.list()).map((key) => [key.id, key.name])),
        accounts: new Map(catalog.accounts().map((a) => [a.id, a.snapshot.label])),
        pools: new Map(catalog.pools().map((pool) => [pool.id, pool.name])),
      }),
      now,
    }),
    recheck,
  }

  return {
    admin,
    verifier,
    dispatcher,
    catalog,
    health,
    scheduler,
    metrics,
    start: async () => {
      // Awaited: serving a request against an empty catalog would look exactly
      // like a deployment with no accounts configured.
      await catalog.refresh()
      catalog.start()
      usage.start()
      // Synchronous by design: the first sweep is not a boot precondition.
      scheduler.start()
      logger.info("runtime ready", {
        component: "runtime",
        accounts: catalog.accounts().length,
        pools: catalog.pools().length,
      })
    },
    stop: async () => {
      // First, and awaited: a tick in flight holds a reserved connection, and the
      // caller closes the pool once this resolves.
      await scheduler.stop()
      catalog.stop()
      await usage.stop()
    },
  }
}
