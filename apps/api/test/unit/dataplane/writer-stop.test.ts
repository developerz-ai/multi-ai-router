import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createQuotaWindowWriter } from "../../../src/services/dataplane/quota-writer"
import { createAccountStatusWriter } from "../../../src/services/dataplane/status-writer"
import { accountRow } from "../../support/account-row"

const now = new Date("2026-10-03T00:00:00Z")
const logger = createLogger({ level: "error", write: () => {} })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
test("quota stop drains a newer reading that arrived during its first flush", async () => {
  const hold = deferred(),
    entered = deferred()
  const writes: number[] = []
  const writer = createQuotaWindowWriter({
    logger,
    flushIntervalMs: 10000,
    accounts: {
      upsertQuotaWindow: async (_id, state) => {
        writes.push(state.utilization ?? -1)
        if (writes.length === 1) {
          entered.resolve()
          await hold.promise
        }
        return {
          id: "window",
          accountId: "account",
          window: state.window,
          revision: writes.length,
          retiredAt: null,
          evidenceState: "current",
          blocksRouting: true,
          utilization: state.utilization ?? null,
          utilizationSource: state.utilizationSource,
          resetsAt: state.resetsAt ?? null,
          resetSource: state.resetSource,
          lastCheckedAt: state.lastCheckedAt,
          createdAt: now,
        }
      },
    },
  })
  writer.record("account", [
    {
      window: "five_hour",
      utilization: 0.2,
      utilizationSource: "continuous",
      resetSource: "unknown",
      lastCheckedAt: now,
    },
  ])
  const flushing = writer.flush()
  await entered.promise
  writer.record("account", [
    {
      window: "five_hour",
      utilization: 0.9,
      utilizationSource: "continuous",
      resetSource: "unknown",
      lastCheckedAt: new Date(now.getTime() + 1),
    },
  ])
  const stopped = writer.stop()
  hold.resolve()
  await Promise.all([flushing, stopped])
  expect(writes).toEqual([0.2, 0.9])
  expect(writer.stats().pending).toBe(0)
})
test("status stop preserves exact generation facts in its final pending pass", async () => {
  const hold = deferred(),
    entered = deferred()
  const generations: string[] = []
  const writer = createAccountStatusWriter({
    logger,
    flushIntervalMs: 10000,
    now: () => now,
    accounts: {
      transitionObservedStatus: async (input) => {
        generations.push(input.expected.recoveryGeneration ?? "none")
        if (generations.length === 1) {
          entered.resolve()
          await hold.promise
        }
        return accountRow({ status: input.status })
      },
    },
  })
  writer.record("a", "needs_reauth", {
    lifecycleVersion: 0,
    authMaterial: null,
    status: "active",
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    observationGeneration: 0,
    verdictVersion: 0,
    recoveryGeneration: "first",
  })
  const flushing = writer.flush()
  await entered.promise
  writer.record("b", "exhausted", {
    lifecycleVersion: 1,
    authMaterial: null,
    status: "active",
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    observationGeneration: 1,
    verdictVersion: 1,
    recoveryGeneration: "second",
  })
  const stopped = writer.stop()
  hold.resolve()
  await Promise.all([flushing, stopped])
  expect(generations).toEqual(["first", "second"])
})
test("stop is bounded and rejects new admission while an acknowledged batch is unresolved", async () => {
  const hold = deferred()
  const writer = createQuotaWindowWriter({
    logger,
    flushIntervalMs: 10000,
    shutdownDrainMs: 5,
    accounts: {
      upsertQuotaWindow: async () => {
        await hold.promise
        throw new Error("offline")
      },
    },
  })
  const reading = {
    window: "five_hour" as const,
    utilization: 1,
    utilizationSource: "continuous" as const,
    resetSource: "unknown" as const,
    lastCheckedAt: now,
  }
  writer.record("a", [reading])
  const flushing = writer.flush()
  await writer.stop()
  writer.record("b", [reading])
  expect(writer.stats().rejectedAfterStop).toBe(1)
  hold.resolve()
  await flushing
})
test("a failed old quota batch cannot replace newer pending evidence on retry", async () => {
  const hold = deferred(),
    entered = deferred()
  let calls = 0
  const values: number[] = []
  const writer = createQuotaWindowWriter({
    logger,
    flushIntervalMs: 10000,
    accounts: {
      upsertQuotaWindow: async (_id, state) => {
        calls++
        if (calls === 1) {
          entered.resolve()
          await hold.promise
          throw new Error("lost acknowledgement")
        }
        values.push(state.utilization ?? -1)
        return {
          id: "q",
          accountId: "a",
          window: state.window,
          revision: 1,
          retiredAt: null,
          evidenceState: "current",
          blocksRouting: true,
          utilization: state.utilization ?? null,
          utilizationSource: state.utilizationSource,
          resetsAt: null,
          resetSource: "unknown",
          lastCheckedAt: state.lastCheckedAt,
          createdAt: now,
        }
      },
    },
  })
  const reading = {
    window: "five_hour" as const,
    utilization: 0.2,
    utilizationSource: "continuous" as const,
    resetSource: "unknown" as const,
    lastCheckedAt: now,
  }
  writer.record("a", [reading])
  const first = writer.flush()
  await entered.promise
  writer.record("a", [{ ...reading, utilization: 0.9, lastCheckedAt: new Date(now.getTime() + 1) }])
  hold.resolve()
  await first
  await writer.stop()
  expect(values).toEqual([0.9])
  expect(writer.stats().pending).toBe(0)
})

test("failed status write retries the exact original observed recovery generation", async () => {
  let calls = 0
  const generations: (string | null | undefined)[] = []
  const writer = createAccountStatusWriter({
    logger,
    flushIntervalMs: 10000,
    now: () => now,
    accounts: {
      transitionObservedStatus: async (input) => {
        generations.push(input.expected.recoveryGeneration)
        if (++calls === 1) throw new Error("offline")
        return accountRow({ status: input.status })
      },
    },
  })
  writer.record("a", "needs_reauth", {
    lifecycleVersion: 2,
    healthRecoveryVersion: 1,
    authRecoveryVersion: 1,
    authMaterial: "cipher",
    status: "active",
    recoveryGeneration: "captured",
    observationGeneration: 1,
    verdictVersion: 1,
  })
  await writer.flush()
  expect(writer.stats().pending).toBe(1)
  await writer.stop()
  expect(generations).toEqual(["captured", "captured"])
  expect(writer.stats().pending).toBe(0)
})

test("forget during a failed status flight does not resurrect its queued verdict", async () => {
  const entered = deferred(),
    finish = deferred()
  const writer = createAccountStatusWriter({
    logger,
    flushIntervalMs: 10000,
    now: () => now,
    accounts: {
      transitionObservedStatus: async () => {
        entered.resolve()
        await finish.promise
        throw new Error("offline")
      },
    },
  })
  writer.record("a", "needs_reauth", {
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authMaterial: null,
    status: "active",
    recoveryGeneration: null,
    observationGeneration: 0,
    verdictVersion: 0,
  })
  const flight = writer.flush()
  await entered.promise
  writer.forget("a")
  finish.resolve()
  await flight
  expect(writer.stats().pending).toBe(0)
  await writer.stop()
})
