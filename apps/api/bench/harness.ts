import { AsyncLocalStorage } from "node:async_hooks"
import type { Dialect, ProviderId } from "@multi-ai-router/core"
import { Hono } from "hono"
import { createLogger } from "../src/logging/logger"
import { errorHandler, notFoundHandler } from "../src/middleware/errorHandler"
import { requestLogger } from "../src/middleware/logger"
import { requestId } from "../src/middleware/requestId"
import { createMetrics, type RouterMetrics } from "../src/observability"
import type { SessionStore } from "../src/providers"
import { metricsRoutes } from "../src/routes/metrics"
import { dataPlaneRoutes } from "../src/routes/v1"
import type { RequestSample, RoutableAccount } from "../src/services/dataplane"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
} from "../src/services/dataplane"
import { createActiveRequestRegistry } from "../src/services/dataplane/active-requests"
import type { PoolSnapshot } from "../src/services/routing/types"
import type { UsageRecord } from "../src/services/usage"
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
import { benchmarkRecovery } from "./recovery"
import { type StubUpstream, TRIP_HEADER } from "./upstream"

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
 * One provider per app, on purpose. A pool mixing two would make the egress path a routing
 * decision, and the bench needs `path="passthrough"` and `path="translate"` to be facts about which
 * app answered, not about which candidate a policy happened to pick. The default app holds a single
 * account; `fleet` gives it a deployment-sized roster of that same provider instead, because the
 * cost of choosing among thirty-one candidates in eleven pools is paid on every prod request and a
 * one-account catalog cannot show it.
 */

/** A roster the size of the deployment the prod overhead numbers come from. */
export interface Fleet {
  readonly accounts: number
  readonly pools: number
}

export interface BenchAppOptions {
  /** Anthropic ingress against an anthropic account is passthrough; anything else translates. */
  readonly provider: ProviderId
  /** The wire the account speaks, when it is not its provider's default. */
  readonly dialect?: Dialect
  /** Absent: one account, no pools, a key scoped to everything. */
  readonly fleet?: Fleet
  readonly upstream: StubUpstream
  readonly sessions?: SessionStore
  readonly bindingKeyId?: string
  readonly subscriptionPresent?: boolean
  readonly onBindingWait?: (milliseconds: number) => void
  readonly onTerminal?: (sample: RequestSample) => void
  readonly onUsage?: (record: UsageRecord) => void
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
  const activeRequests = createActiveRequestRegistry({ maximumEntries: 65_536 })
  const logger = createLogger({ level: LOG_LEVEL, write: () => undefined })

  // The real recorder against a writer that keeps nothing: the enqueue is on the request path and
  // is therefore part of what is being measured, while the drain — and the metric write it feeds —
  // is not, exactly as in production.
  const recorder = createUsageRecorder(
    { write: () => Promise.resolve() },
    {
      onRecord: (record) => {
        metrics.observeUsage(record)
        options.onUsage?.(record)
      },
    },
  )

  const roster = buildRoster(options, cryptor)
  const store = catalog(
    [
      ...roster.accounts,
      ...(options.subscriptionPresent
        ? [
            account("binding-presence", {
              provider: "anthropic-oauth",
              configDir: "/offline-only",
              snapshot: { status: "disabled" },
            }),
          ]
        : []),
    ],
    [...roster.pools],
  )

  const verifier = createRouterKeyVerifier({
    repository: keyRepository([
      apiKeyRow(
        key,
        cryptor,
        options.bindingKeyId === undefined ? {} : { id: options.bindingKeyId },
      ),
    ]),
    cipher: cryptor,
    // A fleet's key is scoped to its pools, as a deployment's keys are: candidates are then the
    // intersection non-negotiable 6 describes, computed on every request.
    loadScope: () =>
      Promise.resolve(
        roster.pools.length === 0
          ? { kind: "all" }
          : { kind: "pools", poolIds: roster.pools.map((pool) => pool.id) },
      ),
  })

  // `AppEnv`, not `RouterKeyEnv`, and mounted the way `app.ts` mounts it: the router-key variables
  // belong to the data-plane sub-app, and hoisting them here would type the shared middleware
  // against an environment the middleware does not require.
  const app = new Hono<AppEnv>()
  const trips = new AsyncLocalStorage<string>()
  // Benchmark correlation is out of band: production deliberately strips arbitrary headers.
  app.use("*", (context, next) => trips.run(context.req.header(TRIP_HEADER) ?? "", next))
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    "/",
    dataPlaneRoutes({
      verifier,
      serverIdleTimeoutSeconds: 60,
      catalog: store,
      health,
      dispatcher: createDispatcher({
        ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
        ...(options.onBindingWait === undefined ? {} : { onBindingWait: options.onBindingWait }),
        activeRequests,
        recovery: benchmarkRecovery(store, health),
        catalog: store,
        health,
        cipher: cryptor,
        usage: recorder,
        fetch: (request) => {
          request.headers.set(TRIP_HEADER, trips.getStore() ?? "")
          return options.upstream.fetch(request)
        },
        onRequest: (sample) => {
          metrics.observeRequest(sample)
          options.onTerminal?.(sample)
        },
        // The streamed attempt's clocks at their production defaults, so a streamed scenario pays
        // what a deployment pays (`dataplane/upstream-deadline.ts`).
        options: {
          upstreamStream: {
            firstByteMs: 300_000,
            idleMs: 55_000,
            totalMs: 3_600_000,
            wallHoldMs: 5_000,
          },
        },
      }),
    }),
  )
  app.route("/", metricsRoutes({ metrics, token: null }))

  return { app, key, metrics, recorder, settle: () => recorder.flush() }
}

interface Roster {
  readonly accounts: readonly RoutableAccount[]
  readonly pools: readonly PoolSnapshot[]
}

function buildRoster(options: BenchAppOptions, cryptor: ReturnType<typeof cipher>): Roster {
  const build = (id: string) =>
    account(id, {
      provider: options.provider,
      apiKey: "sk-bench",
      cipher: cryptor,
      ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
    })
  const fleet = options.fleet
  if (fleet === undefined) return { accounts: [build("bench-account")], pools: [] }

  const accounts = Array.from({ length: fleet.accounts }, (_unused, index) =>
    build(`bench-account-${index}`),
  )
  // Every account in one pool, dealt round the table; the default policy, as most pools run it.
  const pools: PoolSnapshot[] = Array.from({ length: fleet.pools }, (_unused, pool) => ({
    id: `bench-pool-${pool}`,
    name: `bench-pool-${pool}`,
    policy: "sticky",
    members: accounts
      .filter((_account, index) => index % fleet.pools === pool)
      .map((member) => ({ accountId: member.id })),
  }))
  return { accounts, pools }
}

/** The exposition, scraped through the same route a Prometheus would call. */
export async function scrape(bench: BenchApp): Promise<string> {
  await bench.settle()
  const response = await bench.app.request("/metrics")
  return await response.text()
}
