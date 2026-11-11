import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { installCrashHandlers } from "../../../src/services/shutdown/crash-handlers"
import { shutdownPhases } from "../../../src/services/shutdown/phases"
import { runShutdownPhases } from "../../../src/services/shutdown/run-phases"

// 12.2: admission used to close before the readiness grace, so the whole grace answered 503.
test("admission stays open through the readiness grace and closes just before the drain", async () => {
  let admissionOpen = true
  const seen: string[] = []
  await runShutdownPhases(
    shutdownPhases({
      announceUnready: async () => {
        seen.push(`grace:admission-${admissionOpen ? "open" : "closed"}`)
      },
      closeAdmission: () => {
        admissionOpen = false
        seen.push("admission")
      },
      drainHttp: async () => {
        seen.push(`drain:admission-${admissionOpen ? "open" : "closed"}`)
      },
      stopRuntime: async () => {
        seen.push("runtime")
      },
      closeDatabase: async () => {
        seen.push("database")
      },
    }),
    () => undefined,
  )
  expect(seen).toEqual([
    "grace:admission-open",
    "admission",
    "drain:admission-closed",
    "runtime",
    "database",
  ])
})

// 01.13: a failed phase reported only its name.
test("a failed phase hands its reason to the reporter", async () => {
  const reasons: unknown[] = []
  const boom = new Error("usage writer refused")
  await runShutdownPhases(
    [
      {
        name: "runtime",
        run: () => {
          throw boom
        },
      },
    ],
    (_phase, error) => reasons.push(error),
  )
  expect(reasons).toEqual([boom])
})

function crashHarness() {
  const handlers = new Map<string, (reason: unknown) => void>()
  const lines: string[] = []
  const captured: unknown[] = []
  let shutdowns = 0
  installCrashHandlers({
    signals: { on: (event, callback) => handlers.set(event, callback) },
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    capture: (error) => captured.push(error),
    shutdown: () => {
      shutdowns++
    },
  })
  return { handlers, lines, captured, shutdowns: () => shutdowns }
}

// 01.5: Bun exits on an unhandled rejection and prints it unredacted.
test("an unhandled rejection logs one redacted line, is captured, and does not shut down", () => {
  const harness = crashHarness()
  const reason = new Error("connect failed postgres://router:hunter2@db.internal:5432/router")
  harness.handlers.get("unhandledRejection")?.(reason)
  expect(harness.lines).toHaveLength(1)
  expect(harness.lines[0]).not.toContain("hunter2")
  expect(harness.captured).toEqual([reason])
  expect(harness.shutdowns()).toBe(0)
})

test("an uncaught exception logs, is captured, and runs the shutdown", () => {
  const harness = crashHarness()
  harness.handlers.get("uncaughtException")?.(new TypeError("boom"))
  expect(harness.lines).toHaveLength(1)
  expect(JSON.parse(harness.lines[0] ?? "{}").level).toBe("error")
  expect(harness.captured).toHaveLength(1)
  expect(harness.shutdowns()).toBe(1)
})
