import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import type { HealthObservation } from "../../../src/services/dataplane/health-observation"
import { createAccountStatusWriter } from "../../../src/services/dataplane/status-writer"
import { accountRow } from "../../support/account-row"
import { createMemoryStore } from "../../support/memory-store"

test("failed status flush retains exact original quota bundle and complete observation", async () => {
  const account = accountRow()
  const store = createMemoryStore()
  store.rows.accounts.push(account)
  const observation: HealthObservation = {
    ...account,
    recoveryGeneration: null,
    observationGeneration: 1,
    verdictVersion: 0,
  }
  const window = {
    window: "five_hour" as const,
    utilization: 1,
    utilizationSource: "continuous" as const,
    resetSource: "unknown" as const,
    lastCheckedAt: new Date(),
  }
  const captured: unknown[] = []
  let fail = true
  const writer = createAccountStatusWriter({
    accounts: {
      transitionObservedStatus: async (input) => {
        captured.push(input)
        if (fail) {
          fail = false
          throw new Error("offline")
        }
        return store.accounts.transitionObservedStatus(input)
      },
    },
    logger: createLogger({ level: "error", write() {} }),
    flushIntervalMs: 1000,
    now: () => account.updatedAt,
  })
  writer.record(account.id, "exhausted", observation, [window])
  await writer.flush()
  expect(writer.stats()).toMatchObject({ pending: 1, written: 0, writeFailures: 1 })
  await writer.flush()
  expect(captured[1]).toEqual(captured[0])
  expect(writer.stats()).toMatchObject({ pending: 0, written: 1 })
  expect(await store.accounts.findById(account.id)).toMatchObject({ status: "exhausted" })
  expect(
    await store.accounts.upsertObservedQuotaWindow({
      accountId: account.id,
      expected: observation,
      state: window,
    }),
  ).toBeUndefined()
})
