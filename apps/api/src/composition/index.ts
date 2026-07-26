import {
  createAccountRepository,
  createApiKeyRepository,
  createAuditRepository,
  createOauthStateRepository,
  createPoolRepository,
  createPriceOverrideRepository,
  createScheduledTaskRepository,
  createSessionRepository,
  createUsageDailyRepository,
  createUsageRecordRepository,
  type Database,
  type SqlConnection,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import { createRuntimeMetrics, type RouterMetrics } from "../observability"
import { createSdkConcurrency, createSdkInvoker, createSdkQuotaStore } from "../providers"
import { createAccountConfigDirs } from "../providers/claude-sdk/config-dir"
import { type Scheduler, schedulerFromEnv } from "../scheduler"
import { createRoutingCatalog, loadCatalog, type RoutingCatalogStore } from "../services/catalog"
import { createPriceBook } from "../services/cost"
import { createCredentialCipherFromEnv } from "../services/crypto/fromEnv"
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
} from "../services/dataplane"
import { createUsageRecorderFromEnv, type UsageRecorder } from "../services/usage"
import type { AdminServices } from "../types"
import { createAdminPlane } from "./admin"
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
  const usageRecords = createUsageRecordRepository(database)
  // Operator-edited prices. Read at boot into the warm book below, never on the request path.
  const priceOverrides = createPriceOverrideRepository(database)
  // Conversation identity: written by the data plane's session store, swept by the janitor.
  const sessions = createSessionRepository(database)
  const oauthStates = createOauthStateRepository(database)
  // One repository, both directions: the admin read path reads closed days, the rollup closes them.
  const usageDaily = createUsageDailyRepository(database)
  // The scheduler's run log; the usage read path reads it to know which days the rollup closed.
  const scheduledTasks = createScheduledTaskRepository(database)

  // --- warm state -----------------------------------------------------------
  // The breaker's numbers reach it from exactly one place: `breaker.ts` reads no configuration and
  // no randomness of its own, so a store built without them silently runs the module defaults and
  // returns every account tripped in the same second in the same millisecond. `probeHoldMs` is the
  // other half — the gate that admits one half-open probe onto a recovering account.
  const health = createHealthStore({
    failureThreshold: env.failover.failureThreshold,
    baseBackoffMs: env.failover.baseBackoffMs,
    maxBackoffMs: env.failover.maxBackoffMs,
    probeHoldMs: env.failover.halfOpenHoldMs,
  })
  const catalog = createRoutingCatalog({
    load: () => loadCatalog({ accounts, pools }),
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })
  // The shipped price table plus the operator's overrides, held in memory for the same reason the
  // catalog is: every attempt is priced while the request is still being served. It shares the
  // catalog's staleness bound because it is the same kind of value — admin-edited configuration
  // another replica may have changed — and one knob for both is one fewer to explain.
  const prices = createPriceBook({
    load: () => priceOverrides.list(),
    refreshIntervalMs: env.dataPlane.catalogRefreshSeconds * 1_000,
    now,
  })
  // The replica's `claude` subprocess ceiling. Warm state like the two above, and constructed here
  // rather than beside the invoker because it is shared: the dispatch path and the console's "Test
  // now" probe spawn the same ~245 MB process, so they must count against the same budget. A second
  // instance sized the same would bound twice what the operator configured (`concurrency.ts`).
  const sdkConcurrency = createSdkConcurrency({
    global: env.claudeSdkMaxConcurrency,
    perAccount: env.claudeSdkMaxConcurrencyPerAccount,
  })

  // One isolated CLAUDE_CONFIG_DIR per subscription account, and one view of the volume they live
  // on. Built here rather than beside the admin plane because it has a second reader: the
  // scheduler's reaper removes what a crash between provisioning and the insert left behind, and a
  // reaper rooted somewhere other than the provisioner would sweep the wrong directory or nothing
  // at all (`scheduler/tasks/config-dir-reap.ts`).
  const configDirs = createAccountConfigDirs({ root: env.claudeConfigRoot })

  // `usage` is a getter because the recorder below reports *into* this: see `observability/`.
  const metrics = createRuntimeMetrics({
    catalog,
    health,
    usage: () => usage,
    sdkConcurrency,
    logger,
    now,
  })

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
    configDirs,
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

  // The Claude subscription transport. The semaphore pair above and one quota store, keyed by
  // Account and living as long as this runtime — a `rate_limit_event` on one turn is what cools the
  // account down on the next (§5), and a module-level one would bleed between runtimes inside a
  // single process.
  //
  // Built unconditionally: whether a deployment serves subscriptions is a question about its
  // accounts, not about its wiring, and an operator who connects one must not need a restart.
  const sdkQuota = createSdkQuotaStore()
  const invokeSdk = createSdkInvoker({
    concurrency: sdkConcurrency,
    cliPathOverride: env.claudeCliPath,
  })

  const dispatcher = createDispatcher({
    catalog,
    health,
    cipher,
    usage,
    limiter,
    invokeSdk,
    quota: sdkQuota,
    sessions: sessionStore,
    // Synchronous, warm, and the whole reason the book exists: an attempt is priced on the request
    // path, so a lookup that could await a query would put Postgres on it.
    prices: prices.lookup,
    logger,
    onRequest: (sample) => metrics.observeRequest(sample),
    options: {
      failover: { maxAttempts: env.failover.maxAttempts },
      upstreamTimeoutMs: env.failover.upstreamTimeoutMs,
      translation: { defaultMaxTokens: env.translation.defaultMaxTokens },
    },
  })

  // --- admin plane ----------------------------------------------------------
  // Assembled next door, in `composition/admin.ts`: this file owns the process, that one owns the
  // console's API surface. The two things it needs from here are the warm state a console write
  // must invalidate, and the price book a price edit must refresh.
  const { services: admin, refresher } = createAdminPlane({
    env,
    logger,
    now,
    database,
    accounts,
    keys,
    pools,
    auditEvents,
    oauthStates,
    usageDaily,
    scheduledTasks,
    priceOverrides,
    cipher,
    catalog,
    health,
    prices,
    sdkConcurrency,
    configDirs,
    coherence: {
      refreshCatalog: () => catalog.refresh(),
      // A revoked key must stop authenticating *and* stop occupying a rate-limit window.
      invalidateKey: (keyId: string) => {
        verifier.invalidate(keyId)
        limiter.forget(keyId)
      },
    },
  })

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
      // Awaited for the weaker reason: an unloaded book prices off the shipped table, which is
      // wrong rather than absent, and a spend column that corrects itself a second later is worse
      // than one that was right from the first request.
      await prices.refresh()
      prices.start()
      usage.start()
      // Synchronous by design: the first sweep is not a boot precondition.
      scheduler.start()
      // Awaited: rebuilt from `tokenExpiresAt`, so a token that expired during downtime is due now.
      await refresher.start()
      logger.info("runtime ready", {
        component: "runtime",
        accounts: catalog.accounts().length,
        pools: catalog.pools().length,
      })
    },
    stop: async () => {
      // First and awaited: a tick in flight holds a connection the caller's pool close would cut.
      await scheduler.stop()
      await refresher.stop() // same reason: an in-flight token write must land before the pool goes
      admin.connect.stop() // every pending login, so no `claude` subprocess outlives the router
      catalog.stop()
      prices.stop()
      await usage.stop()
    },
  }
}
