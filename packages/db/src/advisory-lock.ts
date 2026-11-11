/**
 * Postgres advisory locks — the whole of the router's leader election.
 *
 * Background work runs in-process on every replica: no broker, no worker
 * container, no cron (docs/idea/01-architecture.md, "Background work and
 * scheduling"). What stops three replicas from running the same sweep three
 * times is one `pg_try_advisory_lock` per task — whoever takes it runs, everyone
 * else returns immediately and writes nothing. The locks themselves are taken on
 * dedicated session pools (`scheduler-lock.ts`, `credential-refresh-lock.ts`,
 * `session-advisory-lock.ts`); this module only derives their keys.
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
 * Stable key for a task name — FNV-1a, folded to the signed 32-bit integer
 * Postgres wants.
 *
 * Pure and deterministic across processes and restarts, which is the only
 * property the lock needs: two replicas naming the same task must compute the
 * same number. A collision between two *different* names would serialize them
 * against each other; the names hashed here are the `scheduled_task` enum values,
 * account ids (credential refresh) and admin subject names, each in its own lock
 * class or namespace prefix.
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

/** `acquired: false` means another replica holds the lock — not a failure. */
export type AdvisoryLockRun<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false }
