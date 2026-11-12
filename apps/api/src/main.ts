import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "@multi-ai-router/core"
import { createDatabase } from "@multi-ai-router/db"
import { createApp } from "./app"
import {
  assertAdminSignInConfigured,
  buildRuntime,
  exitAfterFlush,
  migrate,
  readEnv,
  warnOnInsecureSessionCookie,
} from "./boot"
import type { Env } from "./config/env"
import { listenOptions } from "./config/listen"
import { createLogger, type Logger } from "./logging/logger"
import { captureException, initSentry } from "./observability"
import { createAccountProbe } from "./services/health/accountProbe"
import { createClaudeCliProbe } from "./services/health/claudeCliProbe"
import { createDatabaseProbe } from "./services/health/databaseProbe"
import { installCrashHandlers } from "./services/shutdown/crash-handlers"
import { createLifecycle } from "./services/shutdown/lifecycle"
import { shutdownPhases } from "./services/shutdown/phases"
import { runShutdownPhases } from "./services/shutdown/run-phases"
import { announceUnready, drain, installShutdownHandlers } from "./services/shutdown/transport"

/**
 * The only module that boots: it reads the environment, migrates, builds the app, and opens the
 * listener. Nothing imports it.
 */

async function main(): Promise<void> {
  const env = readEnv()
  const logger = createLogger({ level: env.logLevel })

  // Earliest, after the logger exists: a boot error (a failed migration, a bad config dir) is
  // exactly the kind of failure GlitchTip should see, so the SDK is live before anything that can
  // exit the process runs. No-op when no SENTRY_DSN is set.
  initSentry(env, logger)

  // Before anything can reject: Bun's default for a stray rejection is an immediate exit with the
  // raw, unredacted error on stderr. Until the listener is up there is nothing to drain, so an
  // uncaught exception exits once GlitchTip has the event; after it, `crashShutdown` is replaced
  // by the ordinary drain.
  let crashShutdown = () => {
    void exitAfterFlush(env, 1)
  }
  installCrashHandlers({
    signals: {
      on: (event, callback) => {
        process.on(event, callback)
      },
    },
    logger,
    capture: (error) => captureException(error),
    shutdown: () => crashShutdown(),
  })

  warnOnInsecureSessionCookie(env, logger)

  // Migrations run before the listener opens. A failure exits non-zero rather than serving
  // traffic on a half-migrated schema — docs/idea/09-deployment.md#migrations.
  await migrate(env, logger)

  const database = createDatabase({
    url: env.databaseUrl,
    ...env.databasePool,
  })

  // "OIDC or local" needs the database — the local credential's existence is a
  // row, and the row does not exist until migrations have run. Same fail-fast
  // UX as a malformed variable: the process exits before the listener opens.
  await assertAdminSignInConfigured(env, database, logger)

  const runtime = buildRuntime({
    env,
    database: database.db,
    sql: database.sql,
    dbPoolStats: database.poolStats,
    dbOpenConnections: () => database.openConnections(),
    logger,
  })

  // One latch, read by `/readyz` and by the signal handlers, so readiness cannot go on answering
  // `ready` through a drain nobody told it about — `services/shutdown/lifecycle.ts`.
  const lifecycle = createLifecycle()

  // Before the listener opens: the catalog is loaded and the background writers are
  // running, so the first request is served against real state rather than an empty one.
  await runtime.start()

  // Resolves which `claude` binary the Agent SDK would spawn. Called once here so the winning rung
  // is in the boot log before the first request, then again per `/readyz`.
  const claudeCli = createClaudeCliProbe({
    override: env.claudeCliPath,
    log: logger,
    cacheMs: env.healthCliProbeCacheMs,
  })
  await claudeCli()

  const app = createApp({
    adminBodies: env.adminBodies,
    publicUrl: env.publicUrl,
    logger,
    logQuietPaths: env.logQuietPaths,
    probes: {
      database: createDatabaseProbe({
        handle: database,
        log: logger,
        timeoutMs: env.healthDatabaseProbeTimeoutMs,
      }),
      // Reads the same warm state the request path reads, so the endpoint cannot
      // disagree with the router about what is routable.
      accounts: createAccountProbe({ catalog: runtime.catalog, health: runtime.health }),
      claudeCli,
      shuttingDown: lifecycle.shuttingDown,
    },
    admin: runtime.admin,
    metrics: { metrics: runtime.metrics, token: env.metricsToken },
    dataPlane: {
      verifier: runtime.verifier,
      dispatcher: runtime.dispatcher,
      catalog: runtime.catalog,
      health: runtime.health,
      // `GET /v1/catalog` only: a size and a price beside each reachable model. Both warm, both
      // read synchronously — the listing never touches Postgres.
      models: runtime.models,
      prices: (provider, model) => runtime.prices.lookup(provider, model),
      serverIdleTimeoutSeconds: env.serverIdleTimeoutSeconds,
      // Requests refused before dispatch still count in router_requests_total.
      onUndispatched: (sample) => runtime.metrics.observeRequest(sample),
    },
    trustProxy: env.trustProxy,
    trustProxyHops: env.trustProxyHops,
    sessionCookieInsecure: env.adminAuth.sessionCookieInsecure,
    adminApiToken: env.adminApiToken,
    webRoot: resolveWebRoot(env, logger),
  })

  // The idle timeout is spelled out because Bun's default (10 s, swept every 4 s) is shorter than
  // the 15 s heartbeat a quiet SDK stream sends to stay alive — see `Env.serverIdleTimeoutSeconds`.
  // Inference requests are held off it per request (`middleware/idleClock.ts`); `fetch` hands the
  // server to Hono as `c.env`, which is how that middleware reaches `server.timeout`.
  const server = Bun.serve({ ...listenOptions(env), fetch: app.fetch })
  logger.info("router listening", {
    component: "transport",
    version: VERSION,
    // Which build, not just which version: two images can call themselves 1.0.0 and be different
    // commits. `unknown` when nothing stamped it — see `UNKNOWN_REVISION`.
    revision: env.revision,
    port: server.port,
    logLevel: env.logLevel,
    trustProxy: env.trustProxy,
  })

  // Readiness and HTTP draining precede runtime producer, auxiliary-pool and writer phases.
  // The orchestrator must cover their complete configured bounds plus the final main-pool close.
  const shutdown = () =>
    runShutdownPhases(
      shutdownPhases({
        announceUnready: () => announceUnready(env, logger),
        closeAdmission: () => runtime.closeAdmission(),
        drainHttp: () => drain(server, env, logger),
        stopRuntime: () => runtime.stop(),
        closeDatabase: () => database.close(),
      }),
      (phase, error) =>
        logger.error("shutdown phase failed", {
          component: "transport",
          phase,
          errorClass: "shutdown_phase_failure",
          error,
        }),
    )
  installShutdownHandlers(lifecycle, logger, shutdown)
  crashShutdown = () => {
    // A signal-driven shutdown already under way owns the exit.
    if (!lifecycle.begin()) return
    void shutdown().finally(() => exitAfterFlush(env, 1))
  }
}

/**
 * Where the built SPA lives, or undefined to serve the API alone.
 *
 * The default is `../web` relative to *this module*, which is `dist/web` once `bin/build` has
 * bundled it to `dist/api/index.js` — the same `import.meta.url` trick migrations use to find
 * `dist/migrations`, and for the same reason: the path has to survive bundling.
 *
 * A missing default is not fatal. Running from source (`bin/dev`) has no build output at all, and
 * Vite serves the console on its own port there. A **set** `WEB_ROOT` holding no `index.html` is
 * fatal, following `CLAUDE_CLI_PATH`: what the operator named is used or boot fails, never a
 * silent fall-through to something they did not name.
 */
function resolveWebRoot(env: Env, logger: Logger): string | undefined {
  const root = env.webRoot ?? fileURLToPath(new URL("../web", import.meta.url))
  if (existsSync(join(root, "index.html"))) return root

  if (env.webRoot !== null) {
    process.stderr.write(
      `Invalid environment configuration:\n  WEB_ROOT: no index.html in ${root}\n`,
    )
    process.exit(1)
  }
  logger.warn("no built admin console found — serving the API only", {
    component: "transport",
    webRoot: root,
  })
  return undefined
}

await main()
