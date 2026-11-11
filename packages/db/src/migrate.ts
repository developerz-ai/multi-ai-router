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
  /**
   * Milliseconds one DDL statement may wait for a table lock before the migration — and the boot —
   * fails with {@link MigrationLockTimeoutError}. A DDL queued behind a long read (a usage summary
   * on a running replica) otherwise stalls silently, and every later query on that table queues
   * behind the DDL. Applied only after the migration advisory lock is held, so a replica waiting
   * its turn behind another's migration is not bounded by it. `0` waits forever.
   */
  readonly lockTimeoutMs?: number
  /** Called once when another replica holds the migration lock, before this one blocks on it. */
  readonly onLockWait?: () => void
}

export const MIGRATION_LOCK_TIMEOUT_DEFAULT_MS = 10_000

/**
 * A migration refused to run because the data in front of it breaks its precondition (SQLSTATE
 * `MR001`, raised by the migration itself — e.g. duplicate key names before 0045's unique index).
 * The message names what to fix; nothing was changed.
 */
export class MigrationPreconditionError extends Error {
  override readonly name = "MigrationPreconditionError"
  constructor(detail: string, options: { cause: unknown }) {
    super(`a migration's precondition failed and nothing was applied: ${detail}`, options)
  }
}

/** A migration DDL could not take its table lock within `lockTimeoutMs` (SQLSTATE `55P03`). */
export class MigrationLockTimeoutError extends Error {
  override readonly name = "MigrationLockTimeoutError"
  constructor(lockTimeoutMs: number, options: { cause: unknown }) {
    super(
      `a migration statement waited over ${lockTimeoutMs} ms for a table lock — a long-running query on a running replica holds it; the boot fails rather than queue every query on that table, and the next start retries`,
      options,
    )
  }
}

/**
 * Session-scoped advisory lock so two replicas starting at once converge
 * instead of racing the same DDL. The id is arbitrary but fixed forever.
 */
export const MIGRATION_LOCK_ID = 4_071_150_071

export function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url))
}

/** Applies every pending migration. Idempotent: already-applied files are skipped. */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const folder = options.migrationsFolder ?? defaultMigrationsFolder()
  const lockTimeoutMs = options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_DEFAULT_MS
  // max: 1 pins every statement below to one connection, which is what makes
  // the session-scoped advisory lock actually cover the migration. No statement timeout: an index
  // build is legitimately long, and a cancelled one fails the boot for nothing.
  const handle = createDatabase({
    url: options.url,
    maxConnections: 1,
    connectTimeoutSeconds: options.connectTimeoutSeconds,
    statementTimeoutMs: 0,
    lockTimeoutMs: 0,
    idleInTransactionTimeoutMs: 0,
  })

  try {
    const [first] = await handle.sql<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_ID}) as acquired`
    if (first?.acquired !== true) {
      const onLockWait =
        options.onLockWait ?? (() => log("info", "waiting for another replica's migration"))
      onLockWait()
      await handle.sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    }
    try {
      await handle.sql`select set_config('lock_timeout', ${String(lockTimeoutMs)}, false)`
      await migrate(handle.db, { migrationsFolder: folder }).catch((error: unknown) => {
        const state = sqlState(error)
        if (state === "55P03") throw new MigrationLockTimeoutError(lockTimeoutMs, { cause: error })
        if (state === "MR001")
          throw new MigrationPreconditionError(innermostMessage(error), { cause: error })
        throw error
      })
    } finally {
      await handle.sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`
    }
  } finally {
    await handle.close()
  }
}

/** The driver's own message — drizzle's wrapper message is the failed statement, not the reason. */
function innermostMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (typeof Reflect.get(current, "code") === "string") message = current.message
  }
  return message
}

/** drizzle wraps the driver error; the SQLSTATE is on it or on its cause. */
function sqlState(error: unknown): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, "code")
    if (typeof code === "string") return code
  }
  return undefined
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
