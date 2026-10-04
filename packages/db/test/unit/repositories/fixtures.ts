import { expect } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/pg-proxy"
import type { Database, DatabaseExecutor } from "../../../src/client"

/**
 * No database required. Drizzle's proxy driver hands a repository a real query
 * builder and lets the test see exactly the SQL and parameters that would go on
 * the wire, plus feed rows back the way postgres would return them.
 *
 * That is what is worth locking in a repository unit test: which table each
 * method touches, which predicate narrows it, and what crosses the boundary in
 * each direction. Behaviour that only a live planner can answer — that an index
 * is actually used, that a delete is genuinely bounded under concurrency —
 * belongs in `test/integration`.
 */

export interface Statement {
  readonly sql: string
  readonly params: readonly unknown[]
}

export interface Harness {
  readonly db: Database
  readonly statements: readonly Statement[]
  /** The single statement the method under test issued. */
  only(): Statement
}

/** `rows` is what every statement returns, in `select *` column order. */
export function harness(rows: unknown[][] = []): Harness {
  const statements: Statement[] = []
  // The proxy driver is a `PgRemoteDatabase`, structurally identical for every
  // query these repositories build but branded for a different driver, so the
  // cast is the whole seam. Nothing else here pretends to be postgres.
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params })
    return { rows }
  }) as unknown as Database

  return {
    db,
    statements,
    only: () => {
      expect(statements).toHaveLength(1)
      const statement = statements[0]
      if (statement === undefined) throw new Error("no statement was issued")
      return statement
    },
  }
}

/** `count` returned ids, as postgres answers a `delete … returning "id"`. */
export function deletedRows(count: number): unknown[][] {
  return Array.from({ length: count }, (_, index) => [
    `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  ])
}

/** Compiles transactional repository SQL; real PG integration tests prove atomicity. */
export function transactionHarness(reply: (statement: Statement) => unknown[][] = () => []) {
  const statements: Statement[] = []
  let transactions = 0
  const db = drizzle(async (sql, params) => {
    const statement = { sql, params }
    statements.push(statement)
    if (sql.includes('from "usage_history_state"'))
      return { rows: [["v2", 0, null, "2026-07-01T00:00:00.000Z"]] }
    return { rows: reply(statement) }
  }) as unknown as Database
  db.transaction = (async <T>(run: (tx: DatabaseExecutor) => Promise<T>) => {
    transactions++
    return run(db)
  }) as Database["transaction"]
  db.execute = (async (query: SQL) => {
    statements.push(new PgDialect().sqlToQuery(query))
    return [{ now: new Date("2026-07-01T00:00:00.000Z") }]
  }) as unknown as Database["execute"]
  return { db, statements, transactions: () => transactions }
}
