import {
  createAccountRepository,
  createApiKeyRepository,
  createAuditRepository,
  createModelCatalogRepository,
  createOauthStateRepository,
  createPoolRepository,
  createPriceOverrideRepository,
  createScheduledTaskRepository,
  createSessionRepository,
  createUsageDailyRepository,
  createUsageRecordRepository,
  type Database,
  type PoolSample,
  type SqlConnection,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import { createRuntimeMetrics, type RouterMetrics } from "../observability"
import {
  createSdkConcurrency,
  createSdkInvoker,
  createSdkQuotaStore,
  type SdkQuotaStore,
} from "../providers"
import { createAccountConfigDirs } from "../providers/claude-sdk/config-dir"
import { IDLE_PROBE_MODELS, type Scheduler, schedulerFromEnv } from "../scheduler"
import { createMemorySessionStore } from "../services/admin-auth"
import { createRoutingCatalog, loadCatalog, type RoutingCatalogStore } from "../services/catalog"
import { createPriceBook, type PriceBook } from "../services/cost"
import { createCredentialCipherFromEnv } from "../services/crypto/fromEnv"
import {
  type AccountStatusWriter,
  createAccountStatusWriter,
  createDispatcher,
  createHealthStore,
  createQuotaWindowWriter,
  createRateLimiter,
  createRouterKeyVerifier,
  type Dispatcher,
  type HealthStore,
  type QuotaWindowWriter,
  type RouterKeyVerifier,
  repositoryScopeLoader,
  sessionStoreFromEnv,
  stampLastUsed,
} from "../services/dataplane"
import {
  createModelCatalogStore,
  type ModelCatalogStore,
  refreshAccountCatalog,
} from "../services/models"
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
  /** The same pool's own occupancy sample, for `router_db_pool_connections` — `main.ts`. */
  readonly dbPoolStats: () => PoolSample
  readonly logger: Logger
}

export interface Runtime {
  readonly admin: AdminServices
  readonly verifier: RouterKeyVerifier
  readonly dispatcher: Dispatcher
  readonly catalog: RoutingCatalogStore
  readonly health: HealthStore
  /**
   * The two halves of quota state, exposed for the same reason {@link health} is: they are warm,
   * per-runtime, and invalidated from outside the request that wrote them. One holds what the Agent
   * SDK reported for each Account, the other makes an observed reading durable off the request path.
   */
  readonly sdkQuota: SdkQuotaStore
  readonly quotaWriter: QuotaWindowWriter
  /**
   * The durable half of {@link health}: the standing blocks the breaker forms, written through to
   * `accounts.status` so `exhausted` outlives the process that observed it.
   */
  readonly statusWriter: AccountStatusWriter
  /**
   * The warm model catalog and the warm price book, both exposed for `GET /v1/catalog` — the one
   * listing that answers with a size and a price beside each model. Warm for the reason everything
   * else here is: the endpoint that enumerates the router is the one an operator polls.
   */
  readonly models: ModelCatalogStore
  readonly prices: PriceBook
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
  // What each account's upstream says it serves, and how big. A *description* — the hourly sweep
  // writes it and nothing in selection reads it, which is what lets it refresh on a timer at all
  // while `accounts.supported_models` deliberately does not.
  const modelCatalog = createModelCatalogRepository(database)

  // --- warm state -----------------------------------------------------------
  // The Claude subscription transport's quota state: keyed by Account and living as long as this
  // runtime, because a `rate_limit_event` on one turn is what cools the account down on the next
  // (docs/idea/11-anthropic-agent-sdk.md §5) and a module-level one would bleed between runtimes
  // inside a single process.
  //
  // Built unconditionally: whether a deployment serves subscriptions is a question about its
  // accounts, not about its wiring, and an operator who connects one must not need a restart.
  const sdkQuota = createSdkQuotaStore()
  // The durable half of quota state. A reading is observed by whichever replica served the request,
  // so it is written by that replica, off its request path — never by a scheduled task, whose
  // advisory lock would persist one replica's readings and silently drop everyone else's.
  const quotaWriter = createQuotaWindowWriter({
    accounts,
    logger,
    flushIntervalMs: env.dataPlane.quotaWriteIntervalMs,
  })
  // The durable half of the breaker, and for the same reason: the replica that observed the verdict
  // is the only one holding it. A cooldown is not written — a clock recovers it — but `exhausted`
  // and `needs_reauth` end only when a human acts, and a verdict that dies with the process is a
  // human who never finds out (`services/dataplane/status-writer.ts`).
  const statusWriter = createAccountStatusWriter({
    accounts,
    logger,
    flushIntervalMs: env.dataPlane.accountStatusWriteIntervalMs,
    now,
  })
  // The breaker's numbers reach it from exactly one place: `breaker.ts` reads no configuration and
  // no randomness of its own, so a store built without them silently runs the module defaults and
  // returns every account tripped in the same second in the same millisecond. `probeHoldMs` is the
  // other half — the gate that admits one half-open probe onto a recovering account.
  const health = createHealthStore({
    failureThreshold: env.failover.failureThreshold,
    baseBackoffMs: env.failover.baseBackoffMs,
    maxBackoffMs: env.failover.maxBackoffMs,
    probeHoldMs: env.failover.halfOpenHoldMs,
    // Both transports fold a reading in here and nowhere else, which is what makes one hook enough
    // to make every observed window durable.
    onQuotaWindows: (accountId, windows) => quotaWriter.record(accountId, windows),
    // Every standing block the breaker forms is announced here and nowhere else, which is what
    // makes one hook enough to make every one of them durable. Which of them may be *stored* is
    // the writer's policy, not this file's.
    onBlocked: (accountId, status) => statusWriter.record(accountId, status),
    // "Re-check now" and account deletion clear this store; the SDK's own per-Account buckets are
    // the same request path's memory of the same fact and have to go with them, or the next
    // `rate_limit_event` re-publishes the window the operator just dismissed. A queued status
    // verdict goes for the same reason: landing after the operator's clear would undo a button
    // press with no visible cause.
    onReset: (accountId) => {
      sdkQuota.forget(accountId)
      statusWriter.forget(accountId)
    },
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
  // What the hourly sweep discovered, held warm so `GET /v1/catalog` renders without a query per
  // model. It shares the catalog's staleness bound for the same reason the price book does: it is
  // the same kind of value — a table another replica may have rewritten — and one knob for all
  // three is one fewer to explain.
  const modelCatalogStore = createModelCatalogStore({
    load: () => modelCatalog.list(),
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
    dbPool: { sample: deps.dbPoolStats },
    prices,
    logger,
    now,
    revision: env.revision,
  })

  // Queued in memory, batch-written off-path. Both loss modes reach a log line — see fromEnv.ts.
  const usage: UsageRecorder = createUsageRecorderFromEnv({
    records: usageRecords,
    // Stamped on the same background drain the records are written on, so the idle probe can
    // find an account nothing has routed to without scanning `usage_records`.
    accounts,
    env,
    logger,
    onRecord: (record) => metrics.observeUsage(record),
  })

  // The admin console's session state. Built here, once, rather than left to the auth service's
  // own default — the scheduler's session-purge task and the admin plane's auth service must share
  // this exact instance, or the task sweeps a map nothing ever populates.
  const adminSessions = createMemorySessionStore()

  // --- background work ------------------------------------------------------
  // Every periodic task behind one in-process runner (non-negotiable 13). `schedulerFromEnv` binds
  // the advisory lock to `deps.sql`, so nothing below is ever handed a connection.

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

  // The Claude subscription transport, over the semaphore pair above. Its quota store is built
  // with the rest of the warm state, since `HealthStore.reset` has to be able to clear it.
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
      // The one limit an unauthenticated-shaped mistake can spend memory on before anything else
      // runs, so it is the operator's to set rather than the reader's to assume.
      body: { maxBytes: env.dataPlane.maxRequestBodyBytes },
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
    // The same instance the dispatch path ingests into, so "Test now" and a real request write one
    // account's quota state to one place.
    sdkQuota,
    configDirs,
    sessionStore: adminSessions,
    coherence: {
      refreshCatalog: () => catalog.refresh(),
      // A revoked key must stop authenticating *and* stop occupying a rate-limit window.
      invalidateKey: (keyId: string) => {
        verifier.invalidate(keyId)
        limiter.forget(keyId)
      },
    },
  })

  // Built AFTER the admin plane, not before: the keepalive sweep spends the admin plane's own
  // "Test now" rather than a second probe of its own, so a scheduled probe and an operator's button
  // press share one cooldown, one subprocess gate, and one audit kind. Nothing between the two
  // needed the scheduler, so this is an ordering, not an indirection.
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
    adminSessions,
    testAccount: async (accountId, model) => {
      const result = await admin.testNow.test(accountId, { model, confirmed: true })
      // A refusal (`ok: false`) is a validation outcome — an unknown id, a provider with no
      // implementation. Reported as "not tested" rather than as a failed account, because nothing
      // was sent and the account said nothing about itself.
      return result.ok ? result.value : { tested: false }
    },
    // Free, and asked before anything is billed: a credential that is already dead fails the
    // test for a reason only a human can fix.
    ...(admin.authProbe === undefined ? {} : { authProbe: admin.authProbe }),
    probeModels: IDLE_PROBE_MODELS,
    modelCatalog,
    // Hourly, free, and pointed at `model_catalog` alone: a listing costs no tokens and spends no
    // quota window, and nothing in routing reads what it writes. `supported_models` — which does
    // gate routing — stays the operator's, untouched by any timer.
    refreshCatalog: (account, at) =>
      refreshAccountCatalog(
        {
          catalog: modelCatalog,
          cipher,
          timeoutMs: env.failover.upstreamTimeoutMs,
          fetch: (request) => fetch(request),
        },
        account,
        at,
      ),
    env,
    sql: deps.sql,
    logger,
    now,
    onTick: (result) => metrics.observeTask(result),
  })

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
    start: async () => {
      // Awaited: an empty catalog would look exactly like a deployment with no accounts.
      await catalog.refresh()
      catalog.start()
      // Awaited for the weaker reason: an unloaded book prices off the shipped table, which is
      // wrong rather than absent, and a spend column that corrects itself a second later is worse
      // than one that was right from the first request.
      await prices.refresh()
      prices.start()
      // Not awaited, and the one warm store here that genuinely need not be: an unloaded model
      // catalog makes `GET /v1/catalog` thinner for a moment, which no request path and no report
      // depends on. Failing a boot over it would trade a working router for a listing.
      void modelCatalogStore.refresh().catch((error: unknown) => {
        logger.warn("model catalog did not load at boot", {
          component: "runtime",
          error: error instanceof Error ? error.message : String(error),
        })
      })
      modelCatalogStore.start()
      usage.start()
      quotaWriter.start()
      statusWriter.start()
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
      modelCatalogStore.stop()
      await usage.stop()
      // Last, and awaited: a reading observed a second before shutdown is the freshest thing anyone
      // knows about that account's quota, and losing it means the next boot renders a stale gauge.
      await quotaWriter.stop()
      // Same, and more so: a verdict lost here is an account that comes back `active`, gets a
      // request, and fails it again to re-learn what this process already knew.
      await statusWriter.stop()
    },
  }
}
