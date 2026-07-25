import type { SqlConnection } from "./client"

/**
 * Postgres advisory locks — the whole of the router's leader election.
 *
 * Background work runs in-process on every replica: no broker, no worker
 * container, no cron (docs/idea/01-architecture.md, "Background work and
 * scheduling"). What stops three replicas from running the same sweep three
 * times is one `pg_try_advisory_lock` per task — whoever takes it runs, everyone
 * else returns immediately and writes nothing.
 *
 * **Non-blocking, unlike `migrate.ts`.** The migration runner takes
 * `pg_advisory_lock` and *waits*, because a replica that skipped a migration
 * would serve traffic against the wrong schema. A replica that skips a sweep has
 * simply let the holder do it, so waiting here would only pile connections up
 * behind work that is already happening.
 *
 * **The two-argument lock space is deliberate.** Postgres keeps
 * `pg_try_advisory_lock(bigint)` and `pg_try_advisory_lock(int, int)` in
 * separate spaces, so nothing derived here can ever collide with the migration
 * lock's hand-picked id — which in turn means a task key can be derived from the
 * task's name instead of being another magic number to keep unique by hand.
 */

/**
 * Namespace shared by every router advisory lock. Arbitrary and fixed forever:
 * ASCII `rout`. Changing it would let an old replica and a new one both hold
 * "the same" task lock during a rolling deploy.
 */
const ROUTER_LOCK_CLASS = 0x726f_7574

/**
 * Stable key for a task name — FNV-1a, folded to the signed 32-bit integer
 * Postgres wants.
 *
 * Pure and deterministic across processes and restarts, which is the only
 * property the lock needs: two replicas naming the same task must compute the
 * same number. A collision between two *different* task names would serialize
 * them against each other, so the names are the four values of the
 * `scheduled_task` enum and nothing else.
 */
export function advisoryLockKey(name: string): number {
  let hash = 0x811c_9dc5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    // `Math.imul` is the only 32-bit-exact multiply in JS; `*` would lose the
    // low bits to float64 rounding and make the key platform-dependent.
    hash = Math.imul(hash, 0x0100_0193)
  }
  return hash | 0
}

/**
 * Takes the lock if it is free. Returns immediately either way — never waits.
 *
 * **Session-scoped**: the lock belongs to the connection that took it and is
 * released by {@link advisoryUnlock} on that same connection, or implicitly when
 * the session ends. Pass a connection reserved for the duration, not a pool —
 * see {@link withAdvisoryLock}.
 */
export async function tryAdvisoryLock(sql: SqlConnection, key: number): Promise<boolean> {
  const rows = await sql<
    { locked: boolean }[]
  >`select pg_try_advisory_lock(${ROUTER_LOCK_CLASS}, ${key}) as locked`
  return rows[0]?.locked === true
}

/**
 * Releases a lock this session holds. `false` means the session did not hold it,
 * which is a bug in the caller rather than a race — a task that unlocks what it
 * never locked has lost track of its own connection.
 */
export async function advisoryUnlock(sql: SqlConnection, key: number): Promise<boolean> {
  const rows = await sql<
    { unlocked: boolean }[]
  >`select pg_advisory_unlock(${ROUTER_LOCK_CLASS}, ${key}) as unlocked`
  return rows[0]?.unlocked === true
}

/** `acquired: false` means another replica holds the lock — not a failure. */
export type AdvisoryLockRun<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false }

/**
 * Runs `work` under the lock, or returns `{ acquired: false }` if someone else
 * has it.
 *
 * **The reserved connection is the point.** An advisory lock lives on a session,
 * and a pooled `sql` hands each statement to whichever connection happens to be
 * free — so a lock taken on connection A and released on connection B is not
 * released at all, and leaks until that session is recycled. Reserving pins all
 * three statements to one connection, which is what makes the lock behave the
 * way its name suggests.
 */
export async function withAdvisoryLock<T>(
  sql: SqlConnection,
  key: number,
  work: () => Promise<T>,
): Promise<AdvisoryLockRun<T>> {
  const connection = await sql.reserve()
  try {
    if (!(await tryAdvisoryLock(connection, key))) return { acquired: false }
    try {
      return { acquired: true, value: await work() }
    } finally {
      await advisoryUnlock(connection, key)
    }
  } finally {
    connection.release()
  }
}
