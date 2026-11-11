import { describe, expect, test } from "bun:test"
import { createDatabase, DATABASE_POOL_DEFAULTS } from "../../src/client"

/**
 * The pool's two operator-facing bounds, against a real PostgreSQL: how many connections it will
 * hold, and how long its close waits before it destroys what is still running.
 *
 * Both matter at the same moment. `close()` is the last step of a shutdown already racing the
 * orchestrator's kill, and one connection wedged in a long query used to hold the exit open until
 * the `SIGKILL` landed — losing the flush that ran just before it. Only a real server can hold a
 * connection long enough to show that, which is why this is an integration test.
 *
 * Skips when `DATABASE_URL` is unset, and never silently: `bin/test` names the file on the way out
 * and `bin/check` refuses to run without one.
 */

const databaseUrl = process.env.DATABASE_URL
const skip = databaseUrl === undefined

describe("createDatabase", () => {
  /** One backend pid per statement, so counting distinct pids counts connections actually opened. */
  async function backendsUnderLoad(maxConnections: number): Promise<number> {
    const handle = createDatabase({ url: databaseUrl ?? "", maxConnections })
    try {
      // Each statement holds its connection long enough to overlap the others, so anything the
      // pool is allowed to open, it opens.
      const pids = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const [row] = await handle.sql<{ pid: number }[]>`
            select pg_backend_pid() as pid from pg_sleep(0.1)
          `
          return row?.pid
        }),
      )
      return new Set(pids).size
    } finally {
      await handle.close()
    }
  }

  test.skipIf(skip)("opens no more connections than it was configured to", async () => {
    // Six overlapping statements on a pool of one: the extras queue rather than dial, so every one
    // of them is served by the same backend. Ignore the option and this is six.
    expect(await backendsUnderLoad(1)).toBe(1)
  })

  test.skipIf(skip)("opens more when the operator raises the ceiling", async () => {
    // The other direction, because a pool that always opened one would pass the test above and be
    // just as wrong: one shared pool is the ceiling on the admin plane, the sweeps and the writers
    // at once, and raising it has to actually raise it.
    expect(await backendsUnderLoad(4)).toBeGreaterThan(1)
  })

  test.skipIf(skip)("gives up on an in-flight query at the close timeout", async () => {
    // Far longer than the timeout below, so what ends this query is the close and nothing else.
    const handle = createDatabase({
      url: databaseUrl ?? "",
      maxConnections: 1,
      closeTimeoutSeconds: 1,
    })
    const parked = handle.sql`select pg_sleep(30)`.catch(() => "destroyed")

    const startedAt = performance.now()
    await handle.close()
    const waitedMs = performance.now() - startedAt

    // The bound, not the 30s the query asked for — and comfortably under the 5s default, so a
    // close that ignored the option would be caught rather than merely slower.
    expect(waitedMs).toBeLessThan(3_000)
    expect(await parked).toBe("destroyed")
  })

  test.skipIf(skip)("closes at once at a zero timeout", async () => {
    const handle = createDatabase({
      url: databaseUrl ?? "",
      maxConnections: 1,
      closeTimeoutSeconds: 0,
    })
    const parked = handle.sql`select pg_sleep(30)`.catch(() => "destroyed")

    const startedAt = performance.now()
    await handle.close()

    expect(performance.now() - startedAt).toBeLessThan(2_000)
    expect(await parked).toBe("destroyed")
  })

  test("refuses an empty url rather than dialing nowhere", () => {
    expect(() => createDatabase({ url: "" })).toThrow(/DATABASE_URL is required/)
  })

  test("defaults are the ones the API's DB_POOL_* schema documents", () => {
    // Restated in `apps/api/src/config/env.ts`; this is the end of the rope both hold.
    expect(DATABASE_POOL_DEFAULTS).toEqual({
      maxConnections: 10,
      idleTimeoutSeconds: 30,
      connectTimeoutSeconds: 10,
      maxLifetimeSeconds: 1_800,
      closeTimeoutSeconds: 5,
      statementTimeoutMs: 60_000,
      lockTimeoutMs: 30_000,
      idleInTransactionTimeoutMs: 60_000,
    })
  })

  describe("server-side timeouts", () => {
    /** The SQLSTATE of a rejected statement, wherever the driver put it. */
    const codeOf = (error: unknown): unknown =>
      error instanceof Error ? Reflect.get(error, "code") : undefined

    test.skipIf(skip)(
      "cancels a statement past the bound and the pool serves the next",
      async () => {
        const handle = createDatabase({
          url: databaseUrl ?? "",
          maxConnections: 1,
          statementTimeoutMs: 500,
        })
        try {
          const startedAt = performance.now()
          const failed = await handle.sql`select pg_sleep(5)`.catch((error: unknown) => error)
          expect(codeOf(failed)).toBe("57014")
          expect(performance.now() - startedAt).toBeLessThan(3_000)
          // The one connection was freed, not wedged behind the cancelled statement.
          const [row] = await handle.sql<{ one: number }[]>`select 1 as one`
          expect(row?.one).toBe(1)
        } finally {
          await handle.close()
        }
      },
    )

    test.skipIf(skip)("terminates a transaction left idle past the bound", async () => {
      const handle = createDatabase({
        url: databaseUrl ?? "",
        maxConnections: 1,
        idleInTransactionTimeoutMs: 300,
      })
      try {
        const outcome = await handle.sql
          .begin(async (tx) => {
            await tx`select 1`
            // Idle inside the transaction, as a snapshot whose request was cut would be.
            await Bun.sleep(1_000)
            await tx`select 1`
          })
          .then(
            () => "committed",
            (error: unknown) => codeOf(error) ?? "failed",
          )
        expect(outcome).not.toBe("committed")
        // The pool replaces the terminated session.
        const [row] = await handle.sql<{ one: number }[]>`select 1 as one`
        expect(row?.one).toBe(1)
      } finally {
        await handle.close()
      }
    })

    test.skipIf(skip)("a lock wait fails at the lock bound with 55P03", async () => {
      const holder = createDatabase({ url: databaseUrl ?? "", maxConnections: 1 })
      const waiter = createDatabase({
        url: databaseUrl ?? "",
        maxConnections: 1,
        lockTimeoutMs: 300,
      })
      const key = Math.floor(Math.random() * 1_000_000_000)
      try {
        await holder.sql`select pg_advisory_lock(${key})`
        const failed = await waiter.sql`select pg_advisory_lock(${key})`.catch(
          (error: unknown) => error,
        )
        expect(codeOf(failed)).toBe("55P03")
      } finally {
        await holder.sql`select pg_advisory_unlock(${key})`
        await holder.close()
        await waiter.close()
      }
    })
  })

  describe("openConnections", () => {
    test.skipIf(skip)(
      "counts this pool's open sessions, idle ones included, and no one else's",
      async () => {
        const handle = createDatabase({ url: databaseUrl ?? "", maxConnections: 3 })
        const other = createDatabase({ url: databaseUrl ?? "", maxConnections: 2 })
        try {
          // Three overlapping statements open all three; afterwards they sit idle, still open.
          await Promise.all(Array.from({ length: 3 }, () => handle.sql`select pg_sleep(0.1)`))
          await Promise.all(Array.from({ length: 2 }, () => other.sql`select pg_sleep(0.1)`))
          expect(await handle.openConnections()).toBe(3)
          expect(await other.openConnections()).toBe(2)
        } finally {
          await handle.close()
          await other.close()
        }
      },
    )
  })

  describe("poolStats", () => {
    test.skipIf(skip)("reports idle equal to the ceiling when nothing is running", async () => {
      const handle = createDatabase({ url: databaseUrl ?? "", maxConnections: 3 })
      try {
        expect(handle.poolStats()).toEqual({ inUse: 0, idle: 3, waiting: 0, max: 3 })
      } finally {
        await handle.close()
      }
    })

    test.skipIf(skip)(
      "counts overlapping statements as in_use, and the excess as waiting",
      async () => {
        const handle = createDatabase({ url: databaseUrl ?? "", maxConnections: 2 })
        try {
          // Five overlapping statements on a pool of two: two run, three queue behind them — the same
          // thing postgres.js's own internal queue is doing, seen from the outside.
          const inFlight = Array.from({ length: 5 }, () => handle.sql`select pg_sleep(0.2)`)
          // Let every statement actually dispatch before sampling.
          await Bun.sleep(50)

          expect(handle.poolStats()).toEqual({ inUse: 2, idle: 0, waiting: 3, max: 2 })

          await Promise.all(inFlight)
          expect(handle.poolStats()).toEqual({ inUse: 0, idle: 2, waiting: 0, max: 2 })
        } finally {
          await handle.close()
        }
      },
    )
  })
})
