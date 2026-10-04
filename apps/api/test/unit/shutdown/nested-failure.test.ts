import { expect, test } from "bun:test"
import { createRuntimeLifecycle, RuntimeShutdownFailure } from "../../../src/composition/lifecycle"
import { createLogger } from "../../../src/logging/logger"
import { drainServer, HttpDrainFailure } from "../../../src/services/shutdown/drain"
import { runShutdownPhases } from "../../../src/services/shutdown/run-phases"

test("runtime reports rejected cleanup only after every phase; repeated stop shares failure", async () => {
  const order: string[] = []
  const logged: unknown[] = []
  const runtime = createRuntimeLifecycle({
    logger: {
      ...createLogger({ level: "error", write: () => {} }),
      error(_: string, detail: unknown) {
        logged.push(detail)
      },
    },
    start: async () => {},
    phases: [
      [
        {
          name: "producer",
          run() {
            order.push("producer")
            throw new Error("secret")
          },
        },
      ],
      [
        {
          name: "aux",
          run() {
            order.push("aux")
            throw new Error("secret2")
          },
        },
      ],
      [
        {
          name: "writer",
          run() {
            order.push("writer")
          },
        },
      ],
    ],
  })
  const first = runtime.stop()
  expect(runtime.stop()).toBe(first)
  const result: unknown = await first.catch((error) => error)
  expect(result).toBeInstanceOf(RuntimeShutdownFailure)
  if (!(result instanceof RuntimeShutdownFailure)) throw new Error("missing runtime failure")
  expect(result.steps).toEqual(["producer", "aux"])
  expect(order).toEqual(["producer", "aux", "writer"])
  expect(JSON.stringify(logged)).not.toContain("secret")
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(runtime.stop()).toBe(first)
  let databaseClosed = false
  const failures: string[] = []
  expect(
    await runShutdownPhases(
      [
        { name: "runtime", run: () => runtime.stop() },
        {
          name: "database",
          run() {
            databaseClosed = true
          },
        },
      ],
      (phase) => failures.push(phase),
    ),
  ).toBe(false)
  expect(databaseClosed).toBe(true)
  expect(failures).toEqual(["runtime"])
})

test("startup failure remains original despite failing cleanup and broken logger", async () => {
  const original = new Error("startup")
  let cleaned = 0
  const runtime = createRuntimeLifecycle({
    logger: {
      ...createLogger({ level: "error", write: () => {} }),
      error() {
        throw new Error("logging")
      },
    },
    start: async () => {
      throw original
    },
    phases: [
      [
        {
          name: "aux",
          run() {
            throw new Error("cleanup")
          },
        },
      ],
      [
        {
          name: "writer",
          run() {
            cleaned++
          },
        },
      ],
    ],
  })
  expect(await runtime.start().catch((error) => error)).toBe(original)
  expect(cleaned).toBe(1)
})

for (const synchronous of [false, true])
  test(`HTTP stop ${synchronous ? "throws" : "rejects"}; outer shutdown still cleans runtime/database`, async () => {
    const order: string[] = []
    const logged: string[] = []
    const ok = await runShutdownPhases(
      [
        {
          name: "http",
          run: () =>
            drainServer({
              timeoutMs: 10,
              server: {
                pendingRequests: 1,
                stop() {
                  order.push("http")
                  if (synchronous) throw new Error("secret")
                  return Promise.reject(new Error("secret"))
                },
              },
            }).then(() => {}),
        },
        {
          name: "runtime",
          run() {
            order.push("runtime")
          },
        },
        {
          name: "database",
          run() {
            order.push("database")
          },
        },
      ],
      (phase) => logged.push(phase),
    )
    expect(ok).toBe(false)
    expect(order).toEqual(["http", "runtime", "database"])
    expect(logged).toEqual(["http"])
    const failure: unknown = await drainServer({
      timeoutMs: 10,
      server: { pendingRequests: 0, stop: () => Promise.reject(new Error("private")) },
    }).catch((error) => error)
    expect(failure).toBeInstanceOf(HttpDrainFailure)
    if (!(failure instanceof HttpDrainFailure)) throw new Error("missing drain failure")
    expect(failure.message).toBe("HTTP listener drain failed")
  })

test("successful and deadline HTTP drains keep prior semantics without forced stop", async () => {
  expect(
    (await drainServer({ timeoutMs: 10, server: { pendingRequests: 0, stop: async () => {} } }))
      .timedOut,
  ).toBe(false)
  let calls = 0
  const result = await drainServer({
    timeoutMs: 1,
    server: {
      pendingRequests: 2,
      stop(force) {
        expect(force).toBeUndefined()
        calls++
        return new Promise(() => {})
      },
    },
  })
  expect(result.timedOut).toBe(true)
  expect(result.abandoned).toBe(2)
  expect(calls).toBe(1)
})
