import { expect, test } from "bun:test"
import { createRuntimeLifecycle, RuntimeShutdownFailure } from "../../../src/composition/lifecycle"
import { createLogger } from "../../../src/logging/logger"

const logger = () => createLogger({ level: "error", write: () => undefined })

test("one failing producer still drains all writers and closes both auxiliary pools in order", async () => {
  const events: string[] = []
  const producer = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const lifecycle = createRuntimeLifecycle({
    logger: logger(),
    start: async () => undefined,
    phases: [
      [
        {
          name: "producer",
          run: async () => {
            events.push("producer")
            entered.resolve()
            await producer.promise
            throw new Error("drain failed")
          },
        },
      ],
      [
        {
          name: "scheduler-lock",
          run: () => {
            events.push("scheduler-lock")
            throw new Error("close failed")
          },
        },
        {
          name: "refresh-lock",
          run: () => {
            events.push("refresh-lock")
          },
        },
      ],
      [
        {
          name: "writer",
          run: () => {
            events.push("writer")
          },
        },
      ],
    ],
  })
  const first = lifecycle.stop()
  await entered.promise
  const second = lifecycle.stop()
  expect(second).toBe(first)
  expect(events).toEqual(["producer"])
  producer.resolve()
  const failure = await first.catch((error) => error)
  expect(failure).toBeInstanceOf(RuntimeShutdownFailure)
  expect(failure.steps).toEqual(["producer", "scheduler-lock"])
  expect(failure.message).toBe("runtime cleanup failed")
  expect(events).toEqual(["producer", "scheduler-lock", "refresh-lock", "writer"])
  await expect(lifecycle.stop()).rejects.toBe(failure)
  expect(events).toHaveLength(4)
})

test("stopping during an awaited boot prevents late producer activation and a restart", async () => {
  const read = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let activated = false,
    closes = 0
  const lifecycle = createRuntimeLifecycle({
    logger: logger(),
    start: async (assertStarting) => {
      entered.resolve()
      await read.promise
      assertStarting()
      activated = true
    },
    phases: [
      [
        {
          name: "pool",
          run: () => {
            closes++
          },
        },
      ],
    ],
  })
  const starting = lifecycle.start()
  const rejected = starting.catch((error) => error)
  await entered.promise
  await lifecycle.stop()
  read.resolve()
  expect((await rejected).message).toBe("runtime stopped during startup")
  expect(activated).toBe(false)
  expect(closes).toBe(1)
  await expect(lifecycle.start()).rejects.toThrow("cannot restart a stopped runtime")
})

test("a failed boot cleans up previously started services and preserves its error", async () => {
  const failure = new Error("price load failed")
  let starts = 0,
    closes = 0
  const lifecycle = createRuntimeLifecycle({
    logger: logger(),
    start: async () => {
      starts++
      throw failure
    },
    phases: [
      [
        {
          name: "catalog",
          run: () => {
            closes++
          },
        },
      ],
    ],
  })
  const first = lifecycle.start()
  expect(lifecycle.start()).toBe(first)
  await expect(first).rejects.toBe(failure)
  expect(starts).toBe(1)
  expect(closes).toBe(1)
  await lifecycle.stop()
  expect(closes).toBe(1)
})

test("stop before the boot microtask prevents any startup work", async () => {
  let starts = 0
  const lifecycle = createRuntimeLifecycle({
    logger: logger(),
    start: async () => {
      starts++
    },
    phases: [],
  })
  const starting = lifecycle.start().catch((error) => error)
  await lifecycle.stop()
  expect((await starting).message).toBe("runtime stopped during startup")
  expect(starts).toBe(0)
})
