import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index"

/** The postgres.js connection pool backing a `Database`. */
export type SqlConnection = ReturnType<typeof postgres>

/** A Drizzle instance typed against the full router schema. */
export type Database = PostgresJsDatabase<typeof schema>

export interface DatabaseOptions {
  /** PostgreSQL 16+ connection string, from `DATABASE_URL`. */
  readonly url: string
  /** Pool size. Connections are pooled and kept warm — nothing dials on the hot path. */
  readonly maxConnections?: number
  /** Seconds an idle connection is kept before it is closed. */
  readonly idleTimeoutSeconds?: number
  /** Seconds to wait for a connection before failing. */
  readonly connectTimeoutSeconds?: number
  /** Seconds after which a connection is recycled, so a rolling restart drains cleanly. */
  readonly maxLifetimeSeconds?: number
  /** Emit the SQL Drizzle generates. Development only. */
  readonly logQueries?: boolean
}

export interface DatabaseHandle {
  readonly db: Database
  /** The raw connection, for advisory locks and the migration runner. */
  readonly sql: SqlConnection
  /** Drains the pool. Call on shutdown; never on a request path. */
  close(): Promise<void>
}

const DEFAULTS = {
  maxConnections: 10,
  idleTimeoutSeconds: 30,
  connectTimeoutSeconds: 10,
  maxLifetimeSeconds: 60 * 30,
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

  const sql = postgres(options.url, {
    max: options.maxConnections ?? DEFAULTS.maxConnections,
    idle_timeout: options.idleTimeoutSeconds ?? DEFAULTS.idleTimeoutSeconds,
    connect_timeout: options.connectTimeoutSeconds ?? DEFAULTS.connectTimeoutSeconds,
    max_lifetime: options.maxLifetimeSeconds ?? DEFAULTS.maxLifetimeSeconds,
    // Timestamps cross the wire as UTC and come back as `Date`; the schema
    // declares every timestamp column `with time zone` to match.
    prepare: true,
    onnotice: () => undefined,
  })

  const db = drizzle(sql, { schema, logger: options.logQueries ?? false })

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}
