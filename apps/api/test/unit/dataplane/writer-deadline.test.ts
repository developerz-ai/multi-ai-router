import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createQuotaWindowWriter } from "../../../src/services/dataplane/quota-writer"
import { createAccountStatusWriter } from "../../../src/services/dataplane/status-writer"
import { accountRow } from "../../support/account-row"

const now = new Date(0)
const logger = createLogger({ level: "error", write: () => {} })
function hold() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test("quota deadline retains later rows instead of starting them after the held statement settles", async () => {
  const held = hold()
  let writes = 0
  const writer = createQuotaWindowWriter({
    logger,
    flushIntervalMs: 1000,
    shutdownDrainMs: 5,
    accounts: {
      upsertQuotaWindow: async () => {
        writes++
        await held.promise
        throw new Error("DB unavailable")
      },
    },
  })
  writer.record("a", [
    {
      window: "five_hour",
      utilization: 1,
      utilizationSource: "continuous",
      resetSource: "unknown",
      lastCheckedAt: now,
    },
    {
      window: "seven_day",
      utilization: 1,
      utilizationSource: "continuous",
      resetSource: "unknown",
      lastCheckedAt: now,
    },
  ])
  const flight = writer.flush()
  await writer.stop()
  held.release()
  await flight
  expect(writes).toBe(1)
  expect(writer.stats().pending).toBe(1)
  expect(writer.stats().writeFailures).toBe(1)
})

test("status deadline retains later exact observations instead of issuing late account mutations", async () => {
  const held = hold()
  let writes = 0
  const writer = createAccountStatusWriter({
    logger,
    flushIntervalMs: 1000,
    shutdownDrainMs: 5,
    now: () => now,
    accounts: {
      transitionObservedStatus: async ({ id }) => {
        writes++
        await held.promise
        return accountRow({ id })
      },
    },
  })
  const observation = {
    lifecycleVersion: 0,
    authMaterial: null,
    status: "active" as const,
    recoveryGeneration: null,
  }
  writer.record("a", "exhausted", observation)
  writer.record("b", "needs_reauth", observation)
  const flight = writer.flush()
  await writer.stop()
  held.release()
  await flight
  expect(writes).toBe(1)
  expect(writer.stats().pending).toBe(1)
  expect(writer.stats().written).toBe(1)
})
