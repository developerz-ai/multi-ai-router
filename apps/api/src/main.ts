import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createDatabase, runMigrations } from "@multi-ai-router/db"
import { createApp } from "./app"
import { createRuntime, type Runtime, type RuntimeDeps } from "./composition"
import { type Env, EnvValidationError, parseEnv } from "./config/env"
import { createLogger, type Logger } from "./logging/logger"
import { ConfigDirError } from "./providers/claude-sdk/config-dir"
import { createAccountProbe } from "./services/health/accountProbe"
import { createClaudeCliProbe } from "./services/health/claudeCliProbe"
import { createDatabaseProbe } from "./services/health/databaseProbe"

/**
 * The only module that boots: it reads the environment, migrates, builds the app, and opens the
 * listener. Nothing imports it.
 */

async function main(): Promise<void> {
  const env = readEnv()
  const logger = createLogger({ level: env.logLevel })

  // Migrations run before the listener opens. A failure exits non-zero rather than serving
  // traffic on a half-migrated schema — docs/idea/09-deployment.md#migrations.
  await migrate(env, logger)

  const database = createDatabase({ url: env.databaseUrl })
  const runtime = buildRuntime({ env, database: database.db, sql: database.sql, logger })

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
    },
    admin: runtime.admin,
    metrics: { metrics: runtime.metrics, token: env.metricsToken },
    dataPlane: {
      verifier: runtime.verifier,
      dispatcher: runtime.dispatcher,
      catalog: runtime.catalog,
      health: runtime.health,
    },
    trustProxy: env.trustProxy,
    webRoot: resolveWebRoot(env, logger),
  })

  const server = Bun.serve({ port: env.port, fetch: app.fetch })
  logger.info("router listening", {
    component: "transport",
    port: server.port,
    logLevel: env.logLevel,
    trustProxy: env.trustProxy,
  })

  // Order on the way out mirrors the way in: stop taking traffic, flush what is
  // queued, then close the connection the flush needs.
  installShutdownHandlers(logger, async () => {
    await server.stop()
    await runtime.stop()
    await database.close()
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
    await runMigrations({ url: env.databaseUrl })
    logger.info("migrations applied", { component: "db" })
  } catch (error) {
    logger.error("migration failed — refusing to serve a half-migrated schema", {
      component: "db",
      errorClass: error instanceof Error ? error.name : "unknown",
      reason: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  }
}

function installShutdownHandlers(logger: Logger, shutdown: () => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      logger.info("shutting down", { component: "transport", signal })
      void shutdown().finally(() => process.exit(0))
    })
  }
}

await main()
