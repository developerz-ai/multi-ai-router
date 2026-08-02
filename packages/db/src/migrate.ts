import { fileURLToPath } from "node:url"
import { describeError, scrubCredentials } from "@multi-ai-router/core"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { createDatabase } from "./client"

/**
 * Migrations run at boot, before the listener opens, and a failure fails the
 * boot loudly: the process exits non-zero naming what broke and never serves
 * traffic on a half-migrated schema.
 *
 * Failures here surface as plain `Error`s rather than `RouterError`s — core's
 * hierarchy models request outcomes with HTTP statuses, and a failed migration
 * has no client to answer.
 */
export interface MigrateOptions {
  readonly url: string
  /** Defaults to the `migrations/` directory shipped beside this package. */
  readonly migrationsFolder?: string
  /**
   * Seconds the migration connection waits to be accepted, so an operator who raised
   * `DB_POOL_CONNECT_TIMEOUT_SECONDS` for a slow managed instance does not still fail the boot
   * one step earlier, on the migration that runs before the pool exists.
   */
  readonly connectTimeoutSeconds?: number
}

/**
 * Session-scoped advisory lock so two replicas starting at once converge
 * instead of racing the same DDL. The id is arbitrary but fixed forever.
 */
const MIGRATION_LOCK_ID = 4_071_150_071

export function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url))
}

/** Applies every pending migration. Idempotent: already-applied files are skipped. */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const folder = options.migrationsFolder ?? defaultMigrationsFolder()
  // max: 1 pins every statement below to one connection, which is what makes
  // the session-scoped advisory lock actually cover the migration.
  const handle = createDatabase({
    url: options.url,
    maxConnections: 1,
    connectTimeoutSeconds: options.connectTimeoutSeconds,
  })

  try {
    await handle.sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    try {
      await migrate(handle.db, { migrationsFolder: folder })
    } finally {
      await handle.sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`
    }
  } finally {
    await handle.close()
  }
}

/**
 * The full cause chain, innermost first: "refusing to start on a half-migrated schema" is the one
 * moment the operator must know *why*, and the wrapper's message alone is the statement, not the
 * reason. Bun's multi-address connect refusal — a Postgres outage, the most likely boot failure —
 * is an `AggregateError` whose own message is empty; the helper reads its `.errors`.
 */
function describe(error: unknown): string {
  return describeError(error, Number.POSITIVE_INFINITY)
}

/**
 * The boot-time stderr JSON logger — the labeled exception to "everything logs through the server
 * logger", because it runs before that logger exists. It scrubs the whole line before writing:
 * a connect failure echoes `DATABASE_URL`, userinfo and all, and credentials never leave the
 * router in any log (CLAUDE.md non-negotiable 3).
 */
function log(level: "info" | "error", message: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg: message, component: "db.migrate", ...extra })
  process.stderr.write(`${scrubCredentials(line)}\n`)
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL

  if (url === undefined || url === "") {
    log("error", "DATABASE_URL is not set — cannot migrate")
    process.exit(1)
  }

  const folder = defaultMigrationsFolder()
  const startedAt = Date.now()

  try {
    await runMigrations({ url, migrationsFolder: folder })
    log("info", "migrations applied", {
      migrationsFolder: folder,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    log("error", "migration failed — refusing to start on a half-migrated schema", {
      migrationsFolder: folder,
      error: describe(error),
    })
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
