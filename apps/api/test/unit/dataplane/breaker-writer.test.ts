import { describe, expect, test } from "bun:test"
import type { AccountBreakerRow, BreakerObservation } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createBreakerWriter } from "../../../src/services/dataplane/breaker-writer"

const input: BreakerObservation = {
  accountId: "a",
  expected: {
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authMaterial: "test-ciphertext",
  },
  observedRevision: 0,
  status: "cooling_down",
  cooldownUntil: new Date(60000),
  cooldownSource: "estimated",
  consecutiveFailures: 1,
}
const row: AccountBreakerRow = {
  ...input.expected,
  accountId: "a",
  credentialFingerprint: "digest",
  revision: 1,
  status: "cooling_down",
  cooldownUntil: new Date(60000),
  cooldownSource: "estimated",
  cooldownReason: null,
  consecutiveFailures: 1,
  probeHeldUntil: null,
  capturedGeneration: null,
}
function harness(observe: (value: BreakerObservation) => Promise<AccountBreakerRow | undefined>) {
  const logs: string[] = []
  const acknowledgments: number[] = []
  const writer = createBreakerWriter({
    repository: { observe, setProbeHold: async () => undefined },
    logger: createLogger({
      level: "warn",
      write: (line) => {
        logs.push(line)
      },
    }),
    flushIntervalMs: 1000,
    shutdownDrainMs: 10,
    acknowledge: (_input, result) => {
      acknowledgments.push(result.revision)
    },
  })
  return { writer, logs, acknowledgments }
}
describe("breaker writer", () => {
  test("coalesces off-path and retains a newer observation during a deferred flush", async () => {
    const calls: BreakerObservation[] = []
    let release: ((value: AccountBreakerRow) => void) | undefined
    const h = harness(async (value) => {
      calls.push(value)
      if (calls.length === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return { ...row, revision: 2 }
    })
    h.writer.record(input)
    h.writer.record({ ...input, consecutiveFailures: 2 })
    expect(calls).toHaveLength(0)
    const flush = h.writer.flush()
    h.writer.record({ ...input, consecutiveFailures: 3 })
    release?.(row)
    await flush
    await h.writer.flush()
    expect(calls.map((value) => value.consecutiveFailures)).toEqual([2, 3])
    expect(h.acknowledgments).toEqual([2])
    await h.writer.stop()
  })
  test("retries without logging credential material", async () => {
    let count = 0
    const h = harness(async () => {
      if (++count === 1) throw new Error(input.expected.authMaterial ?? "")
      return row
    })
    h.writer.record(input)
    await h.writer.flush()
    await h.writer.flush()
    expect(count).toBe(2)
    expect(h.logs.join("")).not.toContain("test-ciphertext")
    expect(h.acknowledgments).toEqual([1])
    await h.writer.stop()
  })
  test("forget fences in-flight acknowledgments and failed retries", async () => {
    let reject: ((reason: Error) => void) | undefined
    let count = 0
    const h = harness(async () => {
      count++
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    })
    h.writer.record(input)
    const flush = h.writer.flush()
    h.writer.forget("a")
    reject?.(new Error("failed"))
    await flush
    await h.writer.flush()
    expect(count).toBe(1)
    expect(h.acknowledgments).toEqual([])
    await h.writer.stop()
  })
  test("shutdown is bounded for an unresolved write and closes admission", async () => {
    let count = 0
    const h = harness(async () => {
      count++
      return new Promise(() => {})
    })
    h.writer.record(input)
    await h.writer.stop()
    h.writer.record(input)
    expect(count).toBe(1)
    expect(h.logs.join("")).toContain("breaker shutdown incomplete")
  })
  test("replacement survives a rejected write and reset fences a successful write", async () => {
    let reject: ((reason: Error) => void) | undefined
    const calls: BreakerObservation[] = []
    const h = harness(async (value) => {
      calls.push(value)
      if (calls.length === 1)
        return new Promise((_resolve, fail) => {
          reject = fail
        })
      return row
    })
    h.writer.record(input)
    const flush = h.writer.flush()
    const replacement = { ...input, consecutiveFailures: 4 }
    h.writer.record(replacement)
    reject?.(new Error("write failed"))
    await flush
    await h.writer.flush()
    expect(calls).toEqual([input, replacement])
    await h.writer.stop()

    let release: ((value: AccountBreakerRow) => void) | undefined
    const reset = harness(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    reset.writer.record(input)
    const writing = reset.writer.flush()
    reset.writer.forget("a")
    release?.(row)
    await writing
    expect(reset.acknowledgments).toEqual([])
    await reset.writer.stop()
  })
})
