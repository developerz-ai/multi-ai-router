import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describeError, VERSION } from "@multi-ai-router/core"
import {
  createAdminCredentialRepository,
  createDatabase,
  type DatabaseHandle,
  runMigrations,
} from "@multi-ai-router/db"
import { createApp } from "./app"
import { createRuntime, type Runtime, type RuntimeDeps } from "./composition"
import { type Env, EnvValidationError, parseEnv } from "./config/env"
import { createLogger, type Logger } from "./logging/logger"
import { initSentry } from "./observability"
import { ConfigDirError } from "./providers/claude-sdk/config-dir"
import { adminAuthBootProblem } from "./services/admin-auth"
import { createAccountProbe } from "./services/health/accountProbe"
import { createClaudeCliProbe } from "./services/health/claudeCliProbe"
import { createDatabaseProbe } from "./services/health/databaseProbe"
import { type DrainableServer, drainServer } from "./services/shutdown/drain"
import { createLifecycle, type Lifecycle } from "./services/shutdown/lifecycle"

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

  warnOnInsecureSessionCookie(env, logger)

  // Migrations run before the listener opens. A failure exits non-zero rather than serving
  // traffic on a half-migrated schema — docs/idea/09-deployment.md#migrations.
  await migrate(env, logger)

  const database = createDatabase({ url: env.databaseUrl, ...env.databasePool })

  // "OIDC or local" needs the database — the local credential's existence is a
  // row, and the row does not exist until migrations have run. Same fail-fast
  // UX as a malformed variable: the process exits before the listener opens.
  await assertAdminSignInConfigured(env, database, logger)

  const runtime = buildRuntime({
    env,
    database: database.db,
    sql: database.sql,
    dbPoolStats: database.poolStats,
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
  const claudeCli = createClaudeCliProbe({ override: env.claudeCliPath, log: logger })
  await claudeCli()

  const app = createApp({
    logger,
    probes: {
      database: createDatabaseProbe({ handle: database, log: logger }),
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
    },
    trustProxy: env.trustProxy,
    sessionCookieInsecure: env.adminAuth.sessionCookieInsecure,
    adminApiToken: env.adminApiToken,
    webRoot: resolveWebRoot(env, logger),
  })

  const server = Bun.serve({ port: env.port, fetch: app.fetch })
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

  // Order on the way out mirrors the way in: stop being ready, stop taking traffic and let what is
  // in flight finish, flush what is queued, then close the connection the flush needs. Three of the
  // four carry a deadline — `SHUTDOWN_READY_GRACE_MS`, `SHUTDOWN_DRAIN_MS`,
  // `DB_POOL_CLOSE_TIMEOUT_SECONDS` — and the flush is bounded by the work already in hand. Their
  // sum is what the orchestrator's stop grace has to exceed.
  installShutdownHandlers(lifecycle, logger, async () => {
    await announceUnready(env, logger)
    await drain(server, env, logger)
    await runtime.stop()
    await database.close()
  })
}

/**
 * Keep serving for a moment while the load balancer reads the `503` `/readyz` already returns.
 *
 * The latch is set the instant the signal arrives, so the endpoint is honest from that moment — but
 * an honest answer only helps somebody who can still ask. Once `Bun.serve().stop()` runs the
 * listener refuses new connections *and* stops dispatching on the keep-alive connections it already
 * had (measured against bun 1.3), so without this window the flip has nobody left to tell.
 *
 * Zero by default and therefore skipped entirely: the bundled compose deployment has no readiness
 * gate, and a wait that helps nobody there is just a slower shutdown.
 */
async function announceUnready(env: Env, logger: Logger): Promise<void> {
  if (env.shutdownReadyGraceMs === 0) return
  logger.info("readiness withdrawn — still serving while the load balancer notices", {
    component: "transport",
    graceMs: env.shutdownReadyGraceMs,
  })
  await Bun.sleep(env.shutdownReadyGraceMs)
}

/**
 * Stop accepting, then give what is already in flight a bounded chance to finish.
 *
 * The bound is the point. `Bun.serve().stop()` waits for the last byte of the last response and
 * never gives up, so awaiting it bare hands the exit to the orchestrator's `SIGKILL` — which
 * truncates the streams the wait was protecting and loses every usage row, quota reading and
 * standing block still queued behind it. See `services/shutdown/drain.ts`.
 */
async function drain(server: DrainableServer, env: Env, logger: Logger): Promise<void> {
  const outcome = await drainServer({ server, timeoutMs: env.shutdownDrainMs })
  const detail = {
    component: "transport",
    pending: outcome.pending,
    waitedMs: Math.round(outcome.waitedMs),
    timeoutMs: env.shutdownDrainMs,
  }

  if (outcome.timedOut) {
    logger.warn("drain deadline expired — closing responses still in flight", {
      ...detail,
      abandoned: outcome.abandoned,
      remedy:
        "raise SHUTDOWN_DRAIN_MS, and the orchestrator's stop grace period (stop_grace_period, terminationGracePeriodSeconds) above it",
    })
    return
  }
  logger.info("in-flight requests drained", detail)
}

/**
 * The one setting that trades a security property for reachability, so it announces itself on
 * every boot rather than only in the file where it was set.
 *
 * `warn`, not `info`: the operator who enabled it for a LAN install and later moved the router
 * behind an HTTPS front has no other signal that the session cookie is still riding plaintext,
 * and the boot line is the one thing they will look at when something is wrong.
 */
function warnOnInsecureSessionCookie(env: Env, logger: Logger): void {
  if (!env.adminAuth.sessionCookieInsecure) return
  logger.warn("SESSION_COOKIE_INSECURE is on — the admin session cookie is not Secure", {
    component: "admin-auth",
    risk: "the session rides plaintext and any host sharing this domain can set it; unset this once the console is served over HTTPS",
  })
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

/**
 * The one boot rule `parseEnv` cannot own: "an OIDC relying party OR a local
 * admin credential must exist" — the credential's existence is a database row,
 * so the check runs after migrations and before the listener. The refusal
 * mirrors the env-validation UX: stderr, the remedy, the doc, exit non-zero.
 *
 * When the local door *is* open it announces itself the way
 * `SESSION_COOKIE_INSECURE` does: the operator who enabled it for a laptop and
 * later pointed the router at a public address has no other signal.
 */
async function assertAdminSignInConfigured(
  env: Env,
  database: DatabaseHandle,
  logger: Logger,
): Promise<void> {
  const localCredential = await createAdminCredentialRepository(database.db).get()
  const problem = adminAuthBootProblem({
    oidcConfigured: env.adminOidc !== null,
    localCredentialConfigured: localCredential !== undefined,
    publicUrl: env.publicUrl,
    allowPublicLocalLogin: env.adminAuth.localLoginAllowPublic,
  })
  if (problem !== null) {
    process.stderr.write(`${problem}\n`)
    process.exit(1)
  }

  if (localCredential === undefined) return
  logger.info("admin sign-in: local password is enabled", {
    component: "admin-auth",
    oidc: env.adminOidc !== null,
  })
  if (env.adminAuth.localLoginAllowPublic) {
    logger.warn("ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC is on — a password-only admin door is reachable", {
      component: "admin-auth",
      risk: "the local admin password has no IdP and no MFA in front of it; prefer OIDC for anything but this machine, and see docs/idea/13-admin-oidc.md",
    })
  }
}

/** A malformed environment exits non-zero naming the offending variable, and never starts. */
function readEnv(): Env {
  try {
    return parseEnv(process.env)
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

/**
 * A `CLAUDE_CONFIG_ROOT` that would break subscription OAuth exits the same way a malformed env
 * var does. It is only knowable here — the check needs this host's home directory, which `parseEnv`
 * is deliberately unable to read.
 */
function buildRuntime(deps: RuntimeDeps): Runtime {
  try {
    return createRuntime(deps)
  } catch (error) {
    if (error instanceof ConfigDirError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

async function migrate(env: Env, logger: Logger): Promise<void> {
  try {
    await runMigrations({
      url: env.databaseUrl,
      connectTimeoutSeconds: env.databasePool.connectTimeoutSeconds,
    })
    logger.info("migrations applied", { component: "db" })
  } catch (error) {
    // The full cause chain, innermost first: at this one moment the operator must know *why*,
    // and the wrapper's message alone is the statement, not the reason. A Postgres outage here is
    // an AggregateError whose own message is empty. Unbounded on purpose — the logger redacts,
    // and a pre-cut could split a credential right where the scrub would have matched.
    logger.error("migration failed — refusing to serve a half-migrated schema", {
      component: "db",
      errorClass: error instanceof Error ? error.name : "unknown",
      reason: describeError(error, Number.POSITIVE_INFINITY),
    })
    process.exit(1)
  }
}

/**
 * One shutdown, however many signals arrive.
 *
 * The drain is deliberately long, which makes a second signal likely: an orchestrator escalating,
 * or an operator pressing Ctrl-C again. Re-entering would run the flush twice and close the pool
 * underneath the first pass, so the second signal does the only thing it can honestly mean —
 * stop waiting, now — and exits non-zero, because work was abandoned.
 *
 * `lifecycle.begin()` is what recognises the second one, and it latches before a byte of the
 * shutdown runs: the same instant makes `/readyz` answer `503`, which is the point of doing it
 * here rather than inside the drain.
 */
function installShutdownHandlers(
  lifecycle: Lifecycle,
  logger: Logger,
  shutdown: () => Promise<void>,
): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (!lifecycle.begin()) {
        logger.warn("second signal while shutting down — exiting without finishing the drain", {
          component: "transport",
          signal,
        })
        process.exit(1)
      }
      logger.info("shutting down", { component: "transport", signal })
      void shutdown().finally(() => process.exit(0))
    })
  }
}

await main()
