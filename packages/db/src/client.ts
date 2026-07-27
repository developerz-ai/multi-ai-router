import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { type PoolSample, trackPool } from "./pool-metrics"
import * as schema from "./schema/index"

/** The postgres.js connection pool backing a `Database`. */
export type SqlConnection = ReturnType<typeof postgres>

/** A Drizzle instance typed against the full router schema. */
export type Database = PostgresJsDatabase<typeof schema>

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
  const raw = postgres(options.url, {
    max: maxConnections,
    idle_timeout: options.idleTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.idleTimeoutSeconds,
    connect_timeout: options.connectTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.connectTimeoutSeconds,
    max_lifetime: options.maxLifetimeSeconds ?? DATABASE_POOL_DEFAULTS.maxLifetimeSeconds,
    // Timestamps cross the wire as UTC and come back as `Date`; the schema
    // declares every timestamp column `with time zone` to match.
    prepare: true,
    onnotice: () => undefined,
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
    close: async () => {
      await sql.end({ timeout: closeTimeout })
    },
  }
}
