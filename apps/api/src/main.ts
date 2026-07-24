import { createDatabase, runMigrations } from "@multi-ai-router/db"
import { createApp } from "./app"
import { type Env, EnvValidationError, parseEnv } from "./config/env"
import { createLogger, type Logger } from "./logging/logger"
import { createDatabaseProbe } from "./services/health/databaseProbe"
import { assumeHealthyAccounts } from "./services/health/readiness"

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
  const app = createApp({
    logger,
    probes: {
      database: createDatabaseProbe({ handle: database, log: logger }),
      healthyAccounts: assumeHealthyAccounts,
    },
  })

  const server = Bun.serve({ port: env.port, fetch: app.fetch })
  logger.info("router listening", {
    component: "transport",
    port: server.port,
    logLevel: env.logLevel,
    trustProxy: env.trustProxy,
  })

  installShutdownHandlers(logger, async () => {
    await server.stop()
    await database.close()
  })
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
