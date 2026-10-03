import { expect, test } from "bun:test"
import { createScheduler } from "../../../src/scheduler/runner"
import { alwaysFree, memoryTaskRepository, silentLogger } from "./fixtures"

test("shutdown deadline bounds an uncooperative task and fences its late finish", async () => {
  const repo = memoryTaskRepository()
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let calls = 0
  const scheduler = createScheduler({
    repo,
    logger: silentLogger(),
    lock: alwaysFree(),
    jitterFraction: 0,
    shutdownDrainMs: 10,
    tasks: [
      {
        name: "janitor_sweep",
        intervalMs: 1,
        run: async () => {
          calls++
          entered?.()
          await held
          return { outcome: "success", itemsProcessed: 1 }
        },
      },
    ],
  })
  const running = scheduler.runNow("janitor_sweep")
  await started
  const at = Date.now()
  await scheduler.stop()
  expect(Date.now() - at).toBeLessThan(500)
  scheduler.start()
  expect(calls).toBe(1)
  release?.()
  await running
  expect(repo.rows[0]?.finishedAt).toBeNull()
  await scheduler.stop()
})
test("startup lookup from old lifecycle cannot arm a timer after restart", async () => {
  const repo = memoryTaskRepository()
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let reads = 0,
    calls = 0
  const scheduler = createScheduler({
    repo: {
      ...repo,
      lastRun: async () => {
        reads++
        if (reads === 1) {
          entered?.()
          await held
        }
        return undefined
      },
    },
    logger: silentLogger(),
    lock: alwaysFree(),
    jitterFraction: 0,
    shutdownDrainMs: 10,
    tasks: [
      {
        name: "janitor_sweep",
        intervalMs: 100000,
        startupDelayMs: 2,
        run: async () => {
          calls++
          return { outcome: "success", itemsProcessed: 1 }
        },
      },
    ],
  })
  scheduler.start()
  await started
  await scheduler.stop()
  scheduler.start()
  release?.()
  await Bun.sleep(20)
  await scheduler.stop()
  expect(calls).toBe(1)
})

test("cooperative stop records its partial result while exclusion is retained", async () => {
  const repo = memoryTaskRepository()
  const entered = Promise.withResolvers<void>()
  const scheduler = createScheduler({
    repo,
    logger: silentLogger(),
    lock: alwaysFree(),
    jitterFraction: 0,
    shutdownDrainMs: 100,
    tasks: [
      {
        name: "janitor_sweep",
        intervalMs: 1000,
        run: async ({ signal }) => {
          entered.resolve()
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          return { outcome: "partial", itemsProcessed: 2 }
        },
      },
    ],
  })
  const running = scheduler.runNow("janitor_sweep")
  await entered.promise
  await scheduler.stop()
  expect((await running).status).toBe("partial")
  expect(repo.rows[0]).toMatchObject({ outcome: "partial", itemsProcessed: 2 })
  expect(repo.rows[0]?.finishedAt).not.toBeNull()
})

test("lost lock fences bookkeeping even when task ignores the loss", async () => {
  const repo = memoryTaskRepository()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owner = new AbortController()
  const scheduler = createScheduler({
    repo,
    logger: silentLogger(),
    lock: async (_key, work) => ({ acquired: true, value: await work(owner.signal) }),
    jitterFraction: 0,
    shutdownDrainMs: 100,
    tasks: [
      {
        name: "janitor_sweep",
        intervalMs: 1000,
        run: async () => {
          entered.resolve()
          await release.promise
          return { outcome: "success", itemsProcessed: 1 }
        },
      },
    ],
  })
  const running = scheduler.runNow("janitor_sweep")
  await entered.promise
  owner.abort(new Error("session lost"))
  release.resolve()
  expect((await running).status).toBe("failed")
  expect(repo.rows[0]?.finishedAt).toBeNull()
  await scheduler.stop()
})

test("lock lost during interrupted snapshot cannot mark a successor or begin work", async () => {
  const repo = memoryTaskRepository()
  const previous = await repo.begin("janitor_sweep", new Date(0))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const owner = new AbortController()
  let writes = 0,
    calls = 0
  const scheduler = createScheduler({
    repo: {
      ...repo,
      listInterruptedRunIds: async (task, before, limit) => {
        const ids = await repo.listInterruptedRunIds(task, before, limit)
        entered.resolve()
        await release.promise
        return ids
      },
      markInterruptedRunIds: async (ids, now) => {
        writes++
        return repo.markInterruptedRunIds(ids, now)
      },
    },
    logger: silentLogger(),
    lock: async (_key, work) => ({ acquired: true, value: await work(owner.signal) }),
    jitterFraction: 0,
    shutdownDrainMs: 100,
    tasks: [
      {
        name: "janitor_sweep",
        intervalMs: 1000,
        run: async () => {
          calls++
          return { outcome: "success", itemsProcessed: 1 }
        },
      },
    ],
  })
  const running = scheduler.runNow("janitor_sweep")
  await entered.promise
  owner.abort(new Error("old session lost"))
  const successor = await repo.begin("janitor_sweep", new Date())
  release.resolve()
  expect((await running).status).toBe("failed")
  expect(writes).toBe(0)
  expect(calls).toBe(0)
  expect(repo.rows.find((row) => row.id === previous)?.finishedAt).toBeNull()
  expect(repo.rows.find((row) => row.id === successor)?.finishedAt).toBeNull()
  await scheduler.stop()
})
