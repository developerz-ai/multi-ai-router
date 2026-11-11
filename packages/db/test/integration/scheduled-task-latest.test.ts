import { describe, expect, test } from "bun:test"
import {
  createScheduledTaskRepository,
  type ScheduledTaskName,
} from "../../src/repositories/scheduled-task-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * `latestPerTask` replaces two queries per task on the tasks screen. It must answer exactly what
 * `lastRun` / `lastSuccess` answer per task — including a failure streak after the last success,
 * a run still open, and a task that never ran.
 */
const fixture = ownDatabaseFixture("task_latest")
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 12, minute))

describe.skipIf(ownDatabaseUrl === "")("latestPerTask", () => {
  test("matches per-task lastRun and lastSuccess", async () => {
    const repo = createScheduledTaskRepository(fixture.db())
    const finished = async (
      task: ScheduledTaskName,
      minute: number,
      outcome: "success" | "failed",
    ) => {
      const id = await repo.begin(task, at(minute))
      await repo.finish(id, { outcome, itemsProcessed: minute }, at(minute + 1))
    }
    await finished("janitor_sweep", 0, "success")
    await finished("janitor_sweep", 5, "success")
    await finished("janitor_sweep", 10, "failed")
    await finished("janitor_sweep", 15, "failed")
    await finished("usage_rollup", 3, "failed")
    await finished("cooldown_recheck", 1, "success")
    await repo.begin("cooldown_recheck", at(20))

    const latest = await repo.latestPerTask()
    const ran: ScheduledTaskName[] = ["janitor_sweep", "usage_rollup", "cooldown_recheck"]
    for (const task of ran) {
      expect(latest.lastRun.get(task)).toEqual(await repo.lastRun(task))
      expect(latest.lastSuccess.get(task)).toEqual(await repo.lastSuccess(task))
    }
    expect(latest.lastRun.get("janitor_sweep")?.startedAt).toEqual(at(15))
    expect(latest.lastSuccess.get("janitor_sweep")?.startedAt).toEqual(at(5))
    expect(latest.lastSuccess.has("usage_rollup")).toBe(false)
    expect(latest.lastRun.get("cooldown_recheck")?.finishedAt).toBeNull()
    expect([...latest.lastRun.keys()].sort()).toEqual([...ran].sort())
  })
})
