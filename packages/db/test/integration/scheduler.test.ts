import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { advisoryLockKey, withAdvisoryLock } from "../../src/advisory-lock"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createScheduledTaskRepository } from "../../src/repositories/scheduled-task-repository"
import { scheduledTaskRuns } from "../../src/schema/scheduled-task-runs"

/**
 * `pg_try_advisory_lock` is the whole of the scheduler's leader election
 * (CLAUDE.md non-negotiable 13, `src/advisory-lock.ts`), and whether it
 * actually excludes a second concurrent holder — rather than merely compiling
 * a call that looks like it would — is a question only a real Postgres session
 * answers. A unit test can inject a `TaskLock` that always says yes or no; it
 * cannot prove the two-connection race the runner depends on in production.
 *
 * A lock name unique to this run, not one of the four real `scheduled_task`
 * values, so a `bin/dev` process pointed at the same shared dev database can
 * never contend with — or be mistaken for — these tests. Rows are still
 * written as `janitor_sweep` (a real enum member is required), but every
 * assertion below filters to the ids these tests themselves created.
 */
// `DATABASE_URL` and nothing else: `bin/check` refuses to run without one and
// `bin/test` names this file when it skips, so the skip can no longer be silent.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const MARKER = new Date("1999-06-15T00:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
const runIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 4 })
  db = handle.db
})

afterAll(async () => {
  if (handle !== undefined && runIds.length > 0) {
    await db.delete(scheduledTaskRuns).where(inArray(scheduledTaskRuns.id, runIds))
  }
  await handle?.close()
})

describe.skipIf(!runnable)("advisory lock contention against a live database", () => {
  test("two concurrent holders of the same key: exactly one acquires, exactly one run row", async () => {
    if (handle === undefined) throw new Error("unreachable: describe.skipIf gates this")
    const sql = handle.sql
    const repo = createScheduledTaskRepository(db)
    const key = advisoryLockKey(`test-scheduler-contention-${crypto.randomUUID()}`)

    const runOnce = async (): Promise<{ acquired: boolean; id?: string }> => {
      const run = await withAdvisoryLock(sql, key, async () => {
        const id = await repo.begin("janitor_sweep", MARKER)
        // Hold the lock long enough that the other concurrent call is
        // guaranteed to observe it taken, not win a race against an empty gap.
        await new Promise((resolve) => setTimeout(resolve, 100))
        await repo.finish(id, { outcome: "success", itemsProcessed: 1 }, MARKER)
        return id
      })
      return run.acquired ? { acquired: true, id: run.value } : { acquired: false }
    }

    const [a, b] = await Promise.all([runOnce(), runOnce()])
    const winners = [a, b].filter((result) => result.acquired)
    expect(winners).toHaveLength(1)

    const id = winners[0]?.id
    if (id !== undefined) runIds.push(id)

    const ids = winners.map((w) => w.id).filter((value): value is string => value !== undefined)
    const rows = await db.select().from(scheduledTaskRuns).where(inArray(scheduledTaskRuns.id, ids))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe("success")
  })

  test("a released lock lets the very next tick acquire it again", async () => {
    if (handle === undefined) throw new Error("unreachable: describe.skipIf gates this")
    const sql = handle.sql
    const repo = createScheduledTaskRepository(db)
    const key = advisoryLockKey(`test-scheduler-sequential-${crypto.randomUUID()}`)

    const runOnce = async (): Promise<boolean> => {
      const run = await withAdvisoryLock(sql, key, async () => {
        const id = await repo.begin("janitor_sweep", MARKER)
        await repo.finish(id, { outcome: "success", itemsProcessed: 1 }, MARKER)
        runIds.push(id)
      })
      return run.acquired
    }

    // Sequential, not concurrent: proves `finish` releasing the connection
    // (`withAdvisoryLock`'s `finally`) actually frees the lock rather than
    // leaking it on the session until the pool recycles the connection.
    expect(await runOnce()).toBe(true)
    expect(await runOnce()).toBe(true)
    expect(await runOnce()).toBe(true)
  })
})
