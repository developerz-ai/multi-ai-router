import { expect, test } from "bun:test"
import {
  installFailureAwareShutdownHandlers,
  runShutdownPhases,
} from "../../../src/services/shutdown/run-phases"

for (const failed of ["admission", "readiness-grace", "http-drain", "runtime", "database", null]) {
  test(`all cleanup attempted after ${failed ?? "no"} failure; exit is truthful`, async () => {
    let begun = false
    const order: string[] = []
    const errors: string[] = []
    const exits: number[] = []
    const handlers = new Map<string, () => void>()
    installFailureAwareShutdownHandlers({
      lifecycle: {
        begin() {
          if (begun) return false
          begun = true
          return true
        },
      },
      signals: {
        on(signal, callback) {
          handlers.set(signal, callback)
        },
        exit(code) {
          exits.push(code)
        },
      },
      log(kind) {
        order.push(kind)
      },
      shutdown: () =>
        runShutdownPhases(
          ["admission", "readiness-grace", "http-drain", "runtime", "database"].map((name) => ({
            name,
            run() {
              expect(begun).toBe(true)
              order.push(name)
              if (name === failed) throw new Error("postgres://secret:token@private")
            },
          })),
          (phase) => {
            errors.push(phase)
          },
        ),
    })
    handlers.get("SIGTERM")?.()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(order).toEqual([
      "starting",
      "admission",
      "readiness-grace",
      "http-drain",
      "runtime",
      "database",
    ])
    expect(exits).toEqual([failed === null ? 0 : 1])
    expect(errors).toEqual(failed === null ? [] : [failed])
    expect(JSON.stringify(errors)).not.toContain("secret")
  })
}

test("repeat signal does not rerun pending phases; logger failure cannot skip cleanup", async () => {
  let begin = true
  let starts = 0
  let done: () => void = () => {
    throw new Error("shutdown callback not installed")
  }
  const pending = new Promise<void>((resolve) => {
    done = resolve
  })
  const callbacks: (() => void)[] = []
  const exits: number[] = []
  installFailureAwareShutdownHandlers({
    lifecycle: {
      begin() {
        const result = begin
        begin = false
        return result
      },
    },
    signals: {
      on(_, cb) {
        callbacks.push(cb)
      },
      exit(code) {
        exits.push(code)
      },
    },
    log() {},
    shutdown: async () => {
      starts++
      await pending
      return false
    },
  })
  callbacks[0]?.()
  await Promise.resolve()
  callbacks[1]?.()
  expect(starts).toBe(1)
  expect(exits).toEqual([1])
  done()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(exits).toEqual([1, 1])
  const order: string[] = []
  expect(
    await runShutdownPhases(
      [
        {
          name: "first",
          run() {
            throw new Error("secret")
          },
        },
        {
          name: "last",
          run() {
            order.push("last")
          },
        },
      ],
      () => {
        throw new Error("broken logger")
      },
    ),
  ).toBe(false)
  expect(order).toEqual(["last"])
})

test("unexpected synchronous shutdown failure exits nonzero with sanitized category", async () => {
  const callbacks: (() => void)[] = []
  const exits: number[] = []
  const logs: string[] = []
  installFailureAwareShutdownHandlers({
    lifecycle: { begin: () => true },
    signals: {
      on(_, cb) {
        callbacks.push(cb)
      },
      exit(code) {
        exits.push(code)
      },
    },
    log(kind) {
      logs.push(kind)
    },
    shutdown() {
      throw new Error("secret")
    },
  })
  callbacks[0]?.()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(exits).toEqual([1])
  expect(logs).toEqual(["starting", "failed"])
})
