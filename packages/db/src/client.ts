import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { type PoolSample, trackPool } from "./pool-metrics"
import * as schema from "./schema/index"

/** The postgres.js connection pool backing a `Database`. */
export type SqlConnection = ReturnType<typeof postgres>

/** A Drizzle instance typed against the full router schema. */
export type Database = PostgresJsDatabase<typeof schema>

/** Query surface shared by a pooled database and one transaction (including savepoints). */
export type DatabaseExecutor = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute" | "transaction"
>

export interface DatabaseOptions {
  /** PostgreSQL 16+ connection string, from `DATABASE_URL`. */
  readonly url: string
  /**
   * Pool size. Connections are pooled and kept warm — nothing dials on the hot path.
   *
   * One pool serves the admin plane, the scheduler's sweeps, the off-path usage/quota/status
   * writers and the readiness probe, so this is the ceiling on all of them at once: a long sweep
   * holding a connection is one fewer for the console. `0` would open nothing and queue every
   * query forever, which is why the caller's env schema refuses it.
   */
  readonly maxConnections?: number
  /**
   * Seconds an idle connection is kept before it is closed. `0` keeps it forever — postgres.js
   * treats a falsy timer interval as "never fires" (`src/connection.js#timer`).
   */
  readonly idleTimeoutSeconds?: number
  /**
   * Seconds to wait for a connection before failing. Same falsy rule as the timers above, so `0`
   * is not "fail immediately" but "wait forever" — the env schema refuses it for that reason.
   */
  readonly connectTimeoutSeconds?: number
  /**
   * Seconds after which a connection is recycled, so a rolling restart drains cleanly. `0` never
   * recycles.
   */
  readonly maxLifetimeSeconds?: number
  /**
   * Seconds {@link DatabaseHandle.close} waits for in-flight queries before the pool is destroyed
   * under them, rejecting whatever is still queued.
   *
   * A bound, not a courtesy: `close()` runs last in a shutdown that is already racing the
   * orchestrator's kill, and a wedged connection here would hold the exit open until the `SIGKILL`
   * lands instead. `0` destroys at once.
   */
  readonly closeTimeoutSeconds?: number
  /**
   * Milliseconds any one statement may run before Postgres cancels it (`statement_timeout`,
   * SQLSTATE `57014`). Nothing else cancels a query: postgres.js has no per-query deadline and no
   * repository takes a signal, so a statement whose HTTP caller is long gone otherwise runs — and
   * holds its pooled connection — to completion. Lock waits count toward it. `0` disables it.
   */
  readonly statementTimeoutMs?: number
  /**
   * Milliseconds a statement may wait for a lock before failing (`lock_timeout`, `55P03`). A
   * tighter bound than the statement timeout for the one wait that is never the statement's own
   * work. `0` disables it (the statement timeout still bounds the wait).
   */
  readonly lockTimeoutMs?: number
  /**
   * Milliseconds a transaction may sit idle between statements before Postgres terminates its
   * session (`idle_in_transaction_session_timeout`). Bounds a transaction abandoned mid-way — a
   * repeatable-read usage snapshot whose request was cut — so it cannot pin a connection and an
   * old snapshot forever. `0` disables it.
   */
  readonly idleInTransactionTimeoutMs?: number
  /** Emit the SQL Drizzle generates. Development only. */
  readonly logQueries?: boolean
}

export interface DatabaseHandle {
  readonly db: Database
  /** The raw connection, for advisory locks and the migration runner. */
  readonly sql: SqlConnection
  /** Drains the pool. Call on shutdown; never on a request path. */
  close(): Promise<void>
  /** In-flight/idle/waiting connections, for `router_db_pool_connections` — `pool-metrics.ts`. */
  poolStats(): PoolSample
  /**
   * Server sessions this pool holds open right now, busy or idle — counted in Postgres
   * (`pg_stat_activity`, by this handle's unique `application_name`), because postgres.js exposes
   * no open/close hook short of `debug`, and `debug` makes every query error carry its bound
   * parameters as enumerable fields: a redaction hazard. One statement on this pool, so it counts
   * the connection running it and waits behind a saturated pool; call it off the request path
   * (a metrics scrape) and bound it there.
   */
  openConnections(): Promise<number>
}

/**
 * What an operator gets without naming anything, and the single source of truth for it: the API's
 * `DB_POOL_*` schema defaults to these values, so an unset variable and one set to the documented
 * default cannot drift apart.
 */
export const DATABASE_POOL_DEFAULTS = {
  maxConnections: 10,
  idleTimeoutSeconds: 30,
  connectTimeoutSeconds: 10,
  maxLifetimeSeconds: 60 * 30,
  closeTimeoutSeconds: 5,
  // Equal to the HTTP idle bound (`SERVER_IDLE_TIMEOUT_SECONDS`, 60): no client can still be
  // waiting on a statement older than that. The longest legitimate reads — one usage-summary
  // statement, one bounded retention or backfill batch — finish in seconds.
  statementTimeoutMs: 60_000,
  // Every row/advisory lock the pool takes is held for one short transaction; a 30 s wait means
  // something is wedged, and failing names it sooner than the statement timeout would.
  lockTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 60_000,
} as const

/**
 * Builds a connection pool and the Drizzle instance over it.
 *
 * A factory, not a singleton: this module has no side effects at import time,
 * so tests, the migration runner, and the server each own their own handle and
 * close it themselves.
 */
export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  if (options.url === "") {
    // Deliberately a plain Error, not a `RouterError`: every subclass in core is
    // a request outcome with a fixed HTTP status, and a missing DATABASE_URL is
    // a boot-time configuration failure that no client ever sees.
    throw new Error("createDatabase: `url` is empty — DATABASE_URL is required")
  }

  const maxConnections = options.maxConnections ?? DATABASE_POOL_DEFAULTS.maxConnections
  // Unique per handle (and so per replica and per pool), so `openConnections` counts this pool's
  // sessions and nobody else's. 45 characters, inside Postgres' 63-byte NAMEDATALEN.
  const applicationName = `mar-pool-${crypto.randomUUID()}`
  const raw = postgres(options.url, {
    max: maxConnections,
    idle_timeout: options.idleTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.idleTimeoutSeconds,
    connect_timeout: options.connectTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.connectTimeoutSeconds,
    max_lifetime: options.maxLifetimeSeconds ?? DATABASE_POOL_DEFAULTS.maxLifetimeSeconds,
    // Prepared statements: each distinct query is parsed and planned once per connection.
    // (Timestamps are `with time zone` throughout the schema and come back as `Date`; that is
    // the column type's doing, not this option's.)
    prepare: true,
    onnotice: () => undefined,
    // Startup parameters, so they hold on every connection the pool ever opens — including one
    // reopened after `max_lifetime` — and a `set local` inside a transaction can still narrow them.
    connection: {
      application_name: applicationName,
      statement_timeout: options.statementTimeoutMs ?? DATABASE_POOL_DEFAULTS.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs ?? DATABASE_POOL_DEFAULTS.lockTimeoutMs,
      idle_in_transaction_session_timeout:
        options.idleInTransactionTimeoutMs ?? DATABASE_POOL_DEFAULTS.idleInTransactionTimeoutMs,
    },
  })
  // Wrapped before Drizzle ever sees it, so `db.execute` (which calls `client.unsafe` under the
  // hood) is tracked exactly like the raw `sql\`...\`` calls the repositories and the advisory lock
  // make directly — one wrapper, every statement this process issues through this pool.
  const { sql, sample } = trackPool(raw, maxConnections)

  const db = drizzle(sql, { schema, logger: options.logQueries ?? false })
  const closeTimeout = options.closeTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.closeTimeoutSeconds

  return {
    db,
    sql,
    poolStats: sample,
    openConnections: async () => {
      const [row] = await sql<{ open: number }[]>`
        select count(*)::int as open from pg_stat_activity where application_name = ${applicationName}`
      return row?.open ?? 0
    },
    close: async () => {
      await sql.end({ timeout: closeTimeout })
    },
  }
}
