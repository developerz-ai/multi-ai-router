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
import { createAccountConfigDirs } from "./providers/claude-sdk/config-dir"
import { type Scheduler, schedulerFromEnv } from "./scheduler"
import {
  claudeCliFromEnv,
  connectFromEnv,
  createAccountsService,
  createRecheckService,
  withAvailability,
} from "./services/accounts"
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
  createRateLimiter,
  createRouterKeyVerifier,
  type Dispatcher,
  type HealthStore,
  type RouterKeyVerifier,
  repositoryScopeLoader,
  sessionStoreFromEnv,
  stampLastUsed,
} from "./services/dataplane"
import { createKeysService } from "./services/keys"
import { createPoolsService } from "./services/pools"
import { createUsageRecorderFromEnv, type UsageRecorder } from "./services/usage"
import { createUsageService } from "./services/usage-read"
import type { AdminServices } from "./types"

/**
 * The composition root: every long-lived object in the process is constructed here, exactly once,
 * and injected downward.
 *
 * It exists so the two things that must be true of this system can be *seen* in one file rather
 * than inferred from twenty:
 *
 * 1. **Nothing on the request path touches Postgres.** The catalog is warm, the key cache and the
 *    rate-limit windows are in memory, and usage writes are queued and flushed off-path. A
 *    repository handed to a data-plane object is always a background caller.
 * 2. **The two credential planes never meet.** The admin services and the data plane are built
 *    from the same repositories but are wired into disjoint routers with disjoint guards.
 *
 * Wiring is separated from `createApp` because `createApp` is a pure factory that a test calls with
 * stubs. This function is the production wiring, and it is the only place a `Database` becomes a
 * service.
 */

export interface RuntimeDeps {
  readonly env: Env
  readonly database: Database
  /** The pool behind `database`. One consumer, `schedulerFromEnv` — see the note on its deps. */
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
  // Conversation identity: written by the data plane's session store, swept by the janitor.
  const sessions = createSessionRepository(database)
  const oauthStates = createOauthStateRepository(database)
  // One repository, both directions: the admin read path reads closed days, the rollup closes them.
  const usageDaily = createUsageDailyRepository(database)
  // The scheduler's run log; the usage read path reads it to know which days the rollup closed.
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

  // Queued in memory, batch-written off-path. Both loss modes reach a log line — see fromEnv.ts.
  const usage: UsageRecorder = createUsageRecorderFromEnv({
    records: usageRecords,
    env,
    logger,
    onRecord: (record) => metrics.observeUsage(record),
  })

  // --- background work ------------------------------------------------------
  // Every periodic task behind one in-process runner (non-negotiable 13). `schedulerFromEnv` binds
  // the advisory lock to `deps.sql`, so nothing below is ever handed a connection.
  const scheduler = schedulerFromEnv({
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
    sql: deps.sql,
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
    // Fired, never awaited: `lastUsedAt` is reporting, and a request must not wait on it.
    onVerified: stampLastUsed(keys, logger, now),
  })

  // Per replica by design (`limits.ts`); sized off the key cache — one window per verified key.
  const limiter = createRateLimiter({ maxKeys: env.dataPlane.keyCacheMax })

  // Postgres is the truth, the LRU pair in front of it is the cache. A binding says where a
  // conversation physically lives upstream, so no policy may overrule it and no hash recomputes it.
  const sessionStore = sessionStoreFromEnv({ env, repository: sessions, logger, now })

  const dispatcher = createDispatcher({
    catalog,
    health,
    cipher,
    usage,
    limiter,
    sessions: sessionStore,
    logger,
    onRequest: (sample) => metrics.observeRequest(sample),
    options: {
      failover: { maxAttempts: env.failover.maxAttempts },
      upstreamTimeoutMs: env.failover.upstreamTimeoutMs,
      translation: { defaultMaxTokens: env.translation.defaultMaxTokens },
    },
  })

  // --- admin plane ----------------------------------------------------------
  // The CRUD services know nothing about caches; the `services/admin/coherence.ts` decorators make
  // a write take effect on the request path before the response is written. Without them an account
  // disabled in the console keeps routing, and a revoked key keeps authenticating, until a TTL ends.
  //
  // One isolated CLAUDE_CONFIG_DIR per subscription account, both halves of running the `claude`
  // binary against it, and every login flow behind the one service the admin plane mounts.
  const configDirs = createAccountConfigDirs({ root: env.claudeConfigRoot })
  const cli = claudeCliFromEnv({ accounts, configDirs, audit, env, logger, now })
  const connect = connectFromEnv({ cli, accounts, oauthStates, cipher, audit, env, now })

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

  const accountsService = createAccountsService({ accounts, keys, cipher, configDirs, audit, now })

  const coherence = {
    refreshCatalog: () => catalog.refresh(),
    // A revoked key must stop authenticating *and* stop occupying a rate-limit window.
    invalidateKey: (keyId: string) => {
      verifier.invalidate(keyId)
      limiter.forget(keyId)
    },
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
    // Two decorators in the order they must run: `withCatalogRefresh` makes a write land on the
    // request path, `withAvailability` answers a read with what the router currently observes
    // rather than with the row the operator last wrote.
    accounts: withAvailability(withCatalogRefresh(accountsService, coherence), {
      catalog,
      health,
      recheck,
      now,
    }),
    pools: withPoolCatalogRefresh(
      createPoolsService({ pools, accounts, keys, audit, now }),
      coherence,
    ),
    keys: withKeyInvalidation(
      createKeysService({ keys, pools, accounts, cipher, audit, now }),
      coherence,
    ),
    // Accounts and pools are named from the warm catalog; keys need the one query, unremarkable on
    // the admin plane. A miss means the subject was deleted — spend that happened is still spend.
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
    connect,
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
      // Awaited: an empty catalog would look exactly like a deployment with no accounts.
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
      // First and awaited: a tick in flight holds a connection the caller's pool close would cut.
      await scheduler.stop()
      connect.stop() // every pending login, so no `claude` subprocess outlives the router
      catalog.stop()
      await usage.stop()
    },
  }
}
