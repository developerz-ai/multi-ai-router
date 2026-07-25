import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import type { RouterKeyEnv } from "../../src/middleware/routerKeyAuth"
import { createMetrics } from "../../src/observability"
import type { SdkInvoker, SessionStore } from "../../src/providers"
import { metricsRoutes } from "../../src/routes/metrics"
import { dataPlaneRoutes } from "../../src/routes/v1"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
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
  readonly responses: readonly (() => Response)[]
  readonly maxAttempts?: number
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
}

export function harness(options: HarnessOptions) {
  const accounts = options.accounts ?? [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })]
  const upstream = mockUpstream(options.responses)
  const usage = usageSink()
  const health = createHealthStore()
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

  const app = new Hono<RouterKeyEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(createLogger({ level: "error", write: () => undefined })))
  app.onError(errorHandler(createLogger({ level: "error", write: () => undefined })))
  app.notFound(notFoundHandler())
  app.route(
    "/",
    dataPlaneRoutes({
      verifier,
      catalog: store,
      health,
      now: testClock.now,
      dispatcher: createDispatcher({
        catalog: store,
        health,
        cipher: CRYPTOR,
        usage: usageWithMetrics,
        fetch: upstream.fetch,
        ...(options.invokeSdk === undefined ? {} : { invokeSdk: options.invokeSdk }),
        ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
        clock: testClock,
        onRequest: (sample) => metrics.observeRequest(sample),
        options: {
          failover: { maxAttempts: options.maxAttempts ?? 3 },
          ...(options.selection === undefined ? {} : { selection: options.selection }),
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
