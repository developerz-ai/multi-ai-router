import type { SqlConnection } from "./client"

/**
 * Connections as postgres.js would describe them if it exposed pool internals directly. It does
 * not: `max`, `idle_timeout`, and friends are write-only knobs on the driver's options object, and
 * the queues that actually track reserved/idle/waiting connections (`connecting`, `reserved`,
 * `open`, `busy`, `full` in `postgres/src/index.js`) live in its own module closure, unreachable
 * from a consumer.
 *
 * This counts concurrently in-flight statements instead. Below `max` that is exactly the number of
 * connections doing work — postgres.js gives every dispatched statement its own connection, no
 * multiplexing — and at or beyond it the excess is the driver's own internal queue admitting them
 * one at a time, which is the same thing `waiting` would mean if the driver reported it itself.
 */
export interface PoolSample {
  readonly inUse: number
  readonly idle: number
  readonly waiting: number
  readonly max: number
}

export interface PoolTracker {
  readonly sql: SqlConnection
  sample(): PoolSample
}

/** Methods that dispatch a statement and hand back a promise — every way this codebase issues one. */
const TRACKED_METHODS = new Set(["unsafe", "begin", "reserve"])

/**
 * Wraps a postgres.js connection so every statement it dispatches is counted from the moment it is
 * issued to the moment it settles: tagged-template calls (`sql\`...\``, used directly by
 * `advisory-lock.ts` and the raw-SQL repositories), `sql.unsafe` (how Drizzle issues every query —
 * `drizzle-orm/postgres-js/session.js`), and `sql.begin`/`sql.reserve` (a transaction or a reserved
 * connection held for more than one statement).
 *
 * A `Proxy`, not a subclass or a rebuilt object: postgres.js hands back one callable function with
 * about fifteen properties closing over its own module-private queues, and re-implementing that
 * surface here would be a second copy of the driver to keep in sync with every version bump.
 */
export function trackPool(sql: SqlConnection, max: number): PoolTracker {
  let inFlight = 0

  const track = <T>(result: T): T => {
    inFlight += 1
    const settle = (): void => {
      inFlight -= 1
    }
    // A `.then` subscriber does not consume the promise for its caller — every listener the caller
    // itself attaches still fires independently, and postgres.js dispatches a query on construction,
    // not on its first `.then`, so subscribing here adds no second execution.
    Promise.resolve(result as unknown as Promise<unknown>).then(settle, settle)
    return result
  }

  const wrapped = new Proxy(sql, {
    apply(target, thisArg, args) {
      const call = target as unknown as (...callArgs: unknown[]) => unknown
      return track(Reflect.apply(call, thisArg, args))
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === "function" && typeof prop === "string" && TRACKED_METHODS.has(prop)) {
        const method = value as (...callArgs: unknown[]) => unknown
        return (...callArgs: unknown[]) => track(method.apply(target, callArgs))
      }
      return value
    },
  })

  return {
    sql: wrapped,
    sample: () => ({
      inUse: Math.min(inFlight, max),
      idle: Math.max(0, max - inFlight),
      waiting: Math.max(0, inFlight - max),
      max,
    }),
  }
}
