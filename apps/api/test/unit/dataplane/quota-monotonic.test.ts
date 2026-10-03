import { expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import type { QuotaWindowRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createQuotaWindowWriter } from "../../../src/services/dataplane/quota-writer"
import { mergeQuotaObservation } from "../../../src/services/routing/quota"

const checked = new Date("2026-10-03T10:00:00Z")
const state = (overrides: Partial<QuotaWindowState> = {}): QuotaWindowState => ({
  window: "five_hour",
  utilization: 1,
  utilizationSource: "continuous",
  resetsAt: new Date(checked.getTime() + 10000),
  resetSource: "provider-reported",
  lastCheckedAt: checked,
  ...overrides,
})
test("equal-clock unknown cannot erase known quota; independent restrictive facts merge", () => {
  const held = state()
  expect(
    mergeQuotaObservation(
      held,
      state({
        utilization: undefined,
        resetsAt: undefined,
        utilizationSource: "none",
        resetSource: "unknown",
      }),
    ),
  ).toBe(held)
  const merged = mergeQuotaObservation(
    held,
    state({ utilization: 0.5, resetsAt: new Date(checked.getTime() + 20000) }),
  )
  expect(merged.utilization).toBe(1)
  expect(merged.resetsAt?.getTime()).toBe(checked.getTime() + 20000)
  expect(
    mergeQuotaObservation(
      held,
      state({ lastCheckedAt: new Date(checked.getTime() - 1), utilization: 0 }),
    ),
  ).toBe(held)
})
test("writer coalesces by window and observation clock rather than arrival", async () => {
  const written: QuotaWindowState[] = []
  const writer = createQuotaWindowWriter({
    accounts: {
      upsertQuotaWindow: async (_id, window) => {
        written.push(window)
        return {} as QuotaWindowRow
      },
    },
    logger: createLogger({ level: "error", write: () => undefined }),
    flushIntervalMs: 1000,
  })
  writer.record("a", [state(), state({ window: "seven_day", utilization: 0.9 })])
  writer.record("a", [state({ utilization: 0, lastCheckedAt: new Date(checked.getTime() - 1) })])
  writer.record("a", [state({ window: "seven_day", utilization: 1 })])
  await writer.flush()
  expect(written).toHaveLength(2)
  expect(written.find((entry) => entry.window === "five_hour")?.utilization).toBe(1)
  expect(written.find((entry) => entry.window === "seven_day")?.utilization).toBe(1)
})

test("queued state owns its array, dates, and window fields", async () => {
  const written: QuotaWindowState[] = []
  const writer = createQuotaWindowWriter({
    accounts: {
      upsertQuotaWindow: async (_id, window) => {
        written.push(window)
        return {} as QuotaWindowRow
      },
    },
    logger: createLogger({ level: "error", write: () => undefined }),
    flushIntervalMs: 1000,
  })
  const original = {
    ...state(),
    lastCheckedAt: new Date(checked),
    resetsAt: new Date(checked.getTime() + 10000),
  }
  const incoming = [original]
  writer.record("a", incoming)
  original.utilization = 0
  original.lastCheckedAt.setTime(0)
  original.resetsAt.setTime(0)
  incoming.length = 0
  await writer.flush()
  expect(written).toHaveLength(1)
  expect(written[0]?.utilization).toBe(1)
  expect(written[0]?.lastCheckedAt).toEqual(checked)
  expect(written[0]?.resetsAt?.getTime()).toBe(checked.getTime() + 10000)
})
