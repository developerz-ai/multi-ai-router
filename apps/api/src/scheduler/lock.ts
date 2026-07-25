import { type SqlConnection, withAdvisoryLock } from "@multi-ai-router/db"
import type { TaskLock } from "./types"

/**
 * The production {@link TaskLock}: one `pg_try_advisory_lock` per task name.
 *
 * Separated from the runner so `runner.ts` never names a connection — the whole
 * of the runner's dependency on Postgres is this one function, which is why its
 * tests need no database.
 *
 * `withAdvisoryLock` reserves a connection for the duration of the work, because
 * an advisory lock lives on a *session*: taken on one pooled connection and
 * released on another, it is not released at all. A long sweep therefore holds
 * one connection out of the pool while it runs — deliberate, and the reason
 * tasks work in bounded batches rather than one long transaction.
 */
export function advisoryTaskLock(sql: SqlConnection): TaskLock {
  return (key, work) => withAdvisoryLock(sql, key, work)
}
