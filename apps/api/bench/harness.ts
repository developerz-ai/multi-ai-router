import type { ProviderId } from "@multi-ai-router/core"
import { Hono } from "hono"
import { createLogger } from "../src/logging/logger"
import { errorHandler, notFoundHandler } from "../src/middleware/errorHandler"
import { requestLogger } from "../src/middleware/logger"
import { requestId } from "../src/middleware/requestId"
import { createMetrics, type RouterMetrics } from "../src/observability"
import { metricsRoutes } from "../src/routes/metrics"
import { dataPlaneRoutes } from "../src/routes/v1"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
} from "../src/services/dataplane"
import { createUsageRecorder, type UsageRecorder } from "../src/services/usage"
import type { AppEnv } from "../src/types"
import {
  account,
  apiKeyRow,
  catalog,
  cipher,
  keyRepository,
  newRouterKey,
} from "../test/unit/dataplane/fixtures"
import type { StubUpstream } from "./upstream"

/**
 * The router, booted in memory, wired the way the composition root wires it.
 *
 * The point of a bench is that what it measures is what ships, so the differences from `main.ts`
 * are only the ones a benchmark forces: `fetch` is the stub upstream (no provider, no socket), the
 * key repository is an array (no Postgres — nothing may touch it on the critical path anyway, so a
 * bench that stubbed a *database* would be hiding the thing it exists to prove), and log lines are
 * serialized and then dropped instead of written to stdout, because a terminal's write speed is not
 * this router's overhead. Everything else is the real object: real Hono, real middleware, real key
 * verification, real routing and failover, real relay, real usage recorder, real metrics.
 *
 * The account builders come from the data-plane test fixtures rather than being restated here. They
 * already produce the exact shapes the catalog serves, and a second copy is where the two versions
 * start to disagree (`docs/reusable-code.md`).
 *
 * One account per app, on purpose. A pool with two accounts would make the egress path a routing
 * decision, and the bench needs `path="passthrough"` and `path="translate"` to be facts about which
 * app answered, not about which candidate a policy happened to pick.
 */

export interface BenchAppOptions {
  /** Anthropic ingress against an anthropic account is passthrough; anything else translates. */
  readonly provider: ProviderId
  readonly upstream: StubUpstream
}

export interface BenchApp {
  readonly app: Hono<AppEnv>
  readonly key: string
  readonly metrics: RouterMetrics
  readonly recorder: UsageRecorder
  /** Drains the usage queue so every record has reached the metrics the report reads. */
  settle(): Promise<void>
}

/** Loud enough to serialize a line per request, as production does; the sink is what differs. */
const LOG_LEVEL = "info"

export function benchApp(options: BenchAppOptions): BenchApp {
  const cryptor = cipher()
  const key = newRouterKey()
  const metrics = createMetrics()
  const health = createHealthStore()
  const logger = createLogger({ level: LOG_LEVEL, write: () => undefined })

  // The real recorder against a writer that keeps nothing: the enqueue is on the request path and
  // is therefore part of what is being measured, while the drain — and the metric write it feeds —
  // is not, exactly as in production.
  const recorder = createUsageRecorder(
    { write: () => Promise.resolve() },
    { onRecord: (record) => metrics.observeUsage(record) },
  )

  const store = catalog([
    account("bench-account", { provider: options.provider, apiKey: "sk-bench", cipher: cryptor }),
  ])

  const verifier = createRouterKeyVerifier({
    repository: keyRepository([apiKeyRow(key, cryptor)]),
    cipher: cryptor,
    loadScope: () => Promise.resolve({ kind: "all" }),
  })

  // `AppEnv`, not `RouterKeyEnv`, and mounted the way `app.ts` mounts it: the router-key variables
  // belong to the data-plane sub-app, and hoisting them here would type the shared middleware
  // against an environment the middleware does not require.
  const app = new Hono<AppEnv>()
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
      dispatcher: createDispatcher({
        catalog: store,
        health,
        cipher: cryptor,
        usage: recorder,
        fetch: options.upstream.fetch,
        onRequest: (sample) => metrics.observeRequest(sample),
      }),
    }),
  )
  app.route("/", metricsRoutes({ metrics, token: null }))

  return { app, key, metrics, recorder, settle: () => recorder.flush() }
}

/** The exposition, scraped through the same route a Prometheus would call. */
export async function scrape(bench: BenchApp): Promise<string> {
  await bench.settle()
  const response = await bench.app.request("/metrics")
  return await response.text()
}
