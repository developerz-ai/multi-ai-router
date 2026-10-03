import { expect, test } from "bun:test"
import { advisoryLockKey } from "@multi-ai-router/db"
import { createInterruptedRunMaintenance } from "../../../src/scheduler/orphan-runs"
import { alwaysFree, memoryTaskRepository, NOW } from "./fixtures"

test("historical removed tasks become failed and retention eligible, live owners remain visible", async () => {
  const repo = memoryTaskRepository()
  const old = new Date(NOW.getTime() - 100_000)
  const orphan = await repo.begin("usage_rollup", old)
  const live = await repo.begin("janitor_sweep", old)
  const maintenance = createInterruptedRunMaintenance({
    repo,
    lock: async (key, work, signal) =>
      key === advisoryLockKey("janitor_sweep")
        ? { acquired: false }
        : alwaysFree()(key, work, signal),
    cutoffAgeMs: 1_000,
    batchSize: 10,
    now: () => NOW,
  })
  await maintenance(new AbortController().signal)
  expect(repo.rows.find((row) => row.id === orphan)?.outcome).toBe("failed")
  expect(repo.rows.find((row) => row.id === live)?.finishedAt).toBeNull()
  expect(await repo.deleteOlderThan(new Date(NOW.getTime() + 1), 10)).toBe(1)
  expect(repo.rows.map((row) => row.id)).toEqual([live])
})

test("shutdown during maintenance stops between historical tasks", async () => {
  const repo = memoryTaskRepository()
  await repo.begin("usage_rollup", new Date(0))
  await repo.begin("janitor_sweep", new Date(0))
  const controller = new AbortController()
  let acquired = 0
  await createInterruptedRunMaintenance({
    repo,
    lock: async (key, work, signal) => {
      acquired++
      const result = await alwaysFree()(key, work, signal)
      controller.abort()
      return result
    },
    cutoffAgeMs: 1,
    batchSize: 10,
    now: () => NOW,
  })(controller.signal)
  expect(acquired).toBe(1)
  expect(repo.rows.filter((row) => row.finishedAt === null)).toHaveLength(1)
})

test("a delayed orphan update cannot close a successor inserted after its snapshot", async () => {
  const repo = memoryTaskRepository()
  const prior = await repo.begin("usage_rollup", new Date(0))
  const ids = await repo.listInterruptedRunIds("usage_rollup", NOW, 10)
  const successor = await repo.begin("usage_rollup", NOW)
  expect(await repo.markInterruptedRunIds(ids, NOW)).toBe(1)
  expect(repo.rows.find((row) => row.id === prior)?.outcome).toBe("failed")
  expect(repo.rows.find((row) => row.id === successor)?.finishedAt).toBeNull()
})

test("batch one rotates past a live early task to reclaim a later removed orphan", async () => {
  const repo = memoryTaskRepository()
  const live = await repo.begin("janitor_sweep", new Date(0))
  const orphan = await repo.begin("usage_rollup", new Date(0))
  const maintenance = createInterruptedRunMaintenance({
    repo,
    lock: async (key, work, signal) =>
      key === advisoryLockKey("janitor_sweep")
        ? { acquired: false }
        : alwaysFree()(key, work, signal),
    cutoffAgeMs: 1,
    batchSize: 1,
    now: () => NOW,
  })
  const signal = new AbortController().signal
  await maintenance(signal)
  expect(repo.rows.find((row) => row.id === orphan)?.finishedAt).toBeNull()
  await maintenance(signal)
  expect(repo.rows.find((row) => row.id === orphan)?.outcome).toBe("failed")
  expect(repo.rows.find((row) => row.id === live)?.finishedAt).toBeNull()
})
