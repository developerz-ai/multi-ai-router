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
    })
  })
})
