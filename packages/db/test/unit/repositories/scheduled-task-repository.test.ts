import { describe, expect, test } from "bun:test"
import { createScheduledTaskRepository } from "../../../src/repositories/scheduled-task-repository"
import { harness } from "./fixtures"

/**
 * No database required — see `fixtures.ts` for the proxy-driver seam.
 *
 * What is worth locking here: `begin` and `finish` are two separate statements
 * — a wedged or killed task must show as a stale `startedAt` with a NULL
 * `finishedAt`, not vanish or get silently replaced by a single end-of-run
 * write — and `lastRun` is never filtered to successes, since "still running"
 * and "failed" are both answers worth having.
 */

const RUN_ID = "99999999-9999-9999-9999-999999999999"
const NOW = new Date("2026-07-24T12:00:00.000Z")
/** Drizzle maps a `timestamp with time zone` to an ISO string before it reaches the driver. */
const NOW_PARAM = NOW.toISOString()

/** Row order matches `select *` on `scheduled_task_runs`. */
const runRow = [RUN_ID, "usage_rollup", "2026-07-24 12:00:00+00", null, null, 0, null]

describe("begin", () => {
  test("opens a run for the task and returns its id", async () => {
    const stub = harness([[RUN_ID]])
    const id = await createScheduledTaskRepository(stub.db).begin("usage_rollup", NOW)

    const { sql, params } = stub.only()
    expect(sql).toContain('insert into "scheduled_task_runs"')
    expect(sql).toContain("returning")
    expect(params).toEqual(["usage_rollup", NOW_PARAM])
    expect(id).toBe(RUN_ID)
  })

  test("throws when the statement returns no row", async () => {
    const stub = harness([])
    await expect(createScheduledTaskRepository(stub.db).begin("usage_rollup", NOW)).rejects.toThrow(
      "scheduledTaskRepository.begin: statement returned no row",
    )
  })
})

describe("finish", () => {
  test("closes the run with the outcome and the finish stamp", async () => {
    const stub = harness([runRow])
    const row = await createScheduledTaskRepository(stub.db).finish(
      RUN_ID,
      { outcome: "success", itemsProcessed: 42 },
      NOW,
    )

    const { sql, params } = stub.only()
    expect(sql).toContain('update "scheduled_task_runs" set')
    expect(sql).toContain('"finished_at" = $1')
    expect(sql).toContain('"outcome" = $2')
    expect(sql).toContain('"items_processed" = $3')
    expect(params).toContain("success")
    expect(params).toContain(42)
    expect(params).toContain(RUN_ID)
    expect(row?.id).toBe(RUN_ID)
  })

  test("leaves itemsProcessed at the zero begin() wrote when the caller omits it", async () => {
    const stub = harness([runRow])
    await createScheduledTaskRepository(stub.db).finish(RUN_ID, { outcome: "failed" }, NOW)

    expect(stub.only().sql).not.toContain('"items_processed" = $')
  })

  test("writes the redacted error message when the caller supplies one", async () => {
    const stub = harness([runRow])
    await createScheduledTaskRepository(stub.db).finish(
      RUN_ID,
      { outcome: "failed", error: "connection refused" },
      NOW,
    )

    expect(stub.only().params).toContain("connection refused")
  })

  test("returns undefined when no run has that id", async () => {
    const stub = harness([])
    expect(
      await createScheduledTaskRepository(stub.db).finish(RUN_ID, { outcome: "success" }, NOW),
    ).toBeUndefined()
  })
})

describe("lastRun", () => {
  test("reads the most recent run of a task, newest first", async () => {
    const stub = harness([runRow])
    const row = await createScheduledTaskRepository(stub.db).lastRun("usage_rollup")

    const { sql, params } = stub.only()
    expect(sql).toContain('from "scheduled_task_runs"')
    expect(sql).toContain('"scheduled_task_runs"."task" = $1')
    expect(sql).toContain('order by "scheduled_task_runs"."started_at" desc')
    expect(params).toEqual(["usage_rollup", 1])
    expect(row?.id).toBe(RUN_ID)
  })

  test("returns undefined when the task has never run", async () => {
    const stub = harness([])
    expect(
      await createScheduledTaskRepository(stub.db).lastRun("oauth_state_purge"),
    ).toBeUndefined()
  })

  test("is not filtered to successful runs — a failed or still-running run is what an operator needs to see", async () => {
    const stub = harness([runRow])
    await createScheduledTaskRepository(stub.db).lastRun("usage_rollup")

    expect(stub.only().sql).not.toContain('"outcome" =')
  })
})
