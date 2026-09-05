import { Hono } from "hono"
import { createLogger, type Logger } from "../../src/logging/logger"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import type { RouterKeyEnv } from "../../src/middleware/routerKeyAuth"
import { createMetrics } from "../../src/observability"
import type { SdkInvoker, SdkQuotaStore, SessionStore } from "../../src/providers"
import { metricsRoutes } from "../../src/routes/metrics"
import { type DataPlaneRoutesDeps, dataPlaneRoutes } from "../../src/routes/v1"
import { lookupRates, type RateLookup } from "../../src/services/cost"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
  type HealthStoreOptions,
  type RoutableAccount,
} from "../../src/services/dataplane"
import type { PoolSnapshot, SelectionOptions } from "../../src/services/routing"
import {
  account,
  apiKeyRow,
  catalog,
  cipher,
  clock,
  keyRepository,
  mockUpstream,
  newRouterKey,
  usageSink,
} from "../unit/dataplane/fixtures"

/**
 * The shared data-plane integration harness: real Hono, real middleware, real routing, **mocked
 * upstreams**. Nothing here touches a network or a database — `fetch` and the key repository are
 * injected, which is exactly why they are dependencies.
 *
 * Lifted out of `dataplane.test.ts` so every integration suite exercising the data plane (that file,
 * and `translate.test.ts`) shares one wiring rather than each hand-rolling its own approximation of
 * the composition root.
 */

export const KEY = newRouterKey()
export const CRYPTOR = cipher()

export interface HarnessOptions {
  readonly accounts?: readonly RoutableAccount[]
  readonly pools?: readonly PoolSnapshot[]
  readonly scope?: "all" | "pools" | "accounts"
  readonly poolIds?: readonly string[]
  readonly accountIds?: readonly string[]
  /** An entry may return a promise, to hold one upstream call in flight while the test drives on. */
  readonly responses: readonly (() => Response | Promise<Response>)[]
  readonly maxAttempts?: number
  /** Breaker and half-open-gate tuning, as the composition root passes it from `env.failover`. */
  readonly health?: HealthStoreOptions
  /** Overrides the default `sticky` policy, for a suite that needs a deterministic chain order. */
  readonly selection?: SelectionOptions
  /**
   * The Claude subscription transport, stubbed at the `SdkInvoker` boundary. Omitted means this
   * router serves no subscription account — no `claude` CLI is ever spawned either way.
   */
  readonly invokeSdk?: SdkInvoker
  /**
   * Session -> Account bindings. Omitted means every subscription turn starts a fresh SDK session,
   * which is what a deployment with no store does.
   */
  readonly sessions?: SessionStore
  /**
   * Where an SDK-backed account's `rate_limit_event` folds into quota state. Omitted, a subscription
   * attempt's rate-limit reading is never captured — the same as a deployment that never wires one.
   */
  readonly sdkQuota?: SdkQuotaStore
  /**
   * The operator's price overrides, as the composition root passes them: `PriceBook.lookup`.
   * Omitted, every attempt prices off the table shipped in the image.
   */
  readonly prices?: RateLookup
  /** The body ceiling, as the composition root passes `env.dataPlane.maxRequestBodyBytes`. */
  readonly maxBodyBytes?: number
  /**
   * The warm model catalog behind `GET /v1/catalog`. Omitted means this router was built without
   * one — the route still exists and answers an empty list, the same as a deployment whose hourly
   * sweep has not run yet.
   */
  readonly models?: DataPlaneRoutesDeps["models"]
  /**
   * Where the router's own lines go. Omitted, nothing is written — a suite asserting a log line
   * passes a logger that captures instead.
   */
  readonly logger?: Logger
}

export function harness(options: HarnessOptions) {
  const accounts = options.accounts ?? [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })]
  const upstream = mockUpstream(options.responses)
  const usage = usageSink()
  // Jitter off by default: a test that cannot pin the backoff cannot assert it.
  const health = createHealthStore({ jitter: () => 0, ...options.health })
  const testClock = clock()
  const metrics = createMetrics({ now: testClock.now })
  const store = catalog(accounts, options.pools ?? [])
  // Same shape the composition root wires: the usage sink records for the test's own assertions,
  // and metrics observes off the same call — here synchronously, since this harness has no
  // background drain to feed it from.
  const usageWithMetrics = {
    record: (record: (typeof usage.rows)[number]) => {
      usage.record(record)
      metrics.observeUsage(record)
    },
  }

  const verifier = createRouterKeyVerifier({
    repository: keyRepository([apiKeyRow(KEY, CRYPTOR, { scope: options.scope ?? "all" })]),
    cipher: CRYPTOR,
    loadScope: async (row) =>
      row.scope === "all"
        ? { kind: "all" }
        : row.scope === "pools"
          ? { kind: "pools", poolIds: [...(options.poolIds ?? [])] }
          : { kind: "accounts", accountIds: [...(options.accountIds ?? [])] },
    now: testClock.now,
  })

  const logger = options.logger ?? createLogger({ level: "error", write: () => undefined })
  const app = new Hono<RouterKeyEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    "/",
    dataPlaneRoutes({
      verifier,
      catalog: store,
      health,
      now: testClock.now,
      ...(options.models === undefined
        ? {}
        : {
            models: options.models,
            // The same book the attempt is priced against, so a catalog price and a usage row
            // can never disagree about what a model costs.
            prices: (provider, model) => (options.prices ?? lookupRates)(provider, model) ?? null,
          }),
      dispatcher: createDispatcher({
        catalog: store,
        health,
        cipher: CRYPTOR,
        usage: usageWithMetrics,
        fetch: upstream.fetch,
        ...(options.invokeSdk === undefined ? {} : { invokeSdk: options.invokeSdk }),
        ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
        ...(options.sdkQuota === undefined ? {} : { quota: options.sdkQuota }),
        ...(options.prices === undefined ? {} : { prices: options.prices }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        clock: testClock,
        onRequest: (sample) => metrics.observeRequest(sample),
        options: {
          failover: { maxAttempts: options.maxAttempts ?? 3 },
          ...(options.selection === undefined ? {} : { selection: options.selection }),
          ...(options.maxBodyBytes === undefined
            ? {}
            : { body: { maxBytes: options.maxBodyBytes } }),
        },
      }),
    }),
  )
  app.route("/", metricsRoutes({ metrics, token: null }))

  return { app, upstream, usage, health, clock: testClock, metrics }
}

export const MESSAGE = JSON.stringify({
  model: "claude-opus-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
})

export function post(body = MESSAGE, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  }
}

export function bearer(): Record<string, string> {
  return { authorization: `Bearer ${KEY}` }
}

export async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
