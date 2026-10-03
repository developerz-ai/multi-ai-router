import { expect, test } from "bun:test"
import { createConfigDirReapTask } from "../../../src/scheduler/tasks/config-dir-reap"
import { NOW, silentLogger } from "./fixtures"

test("owner-held directory is deferred and retried without claiming removal", async () => {
  const accountId = "11111111-1111-4111-8111-111111111111"
  let held = true
  let attempts = 0
  const warnings: string[] = []
  const task = createConfigDirReapTask({
    configDirs: {
      root: "/offline/accounts",
      list: async () => [{ name: accountId, accountId, changedAtMs: 0 }],
      remove: async () => {
        attempts++
        return held ? "deferred" : "removed"
      },
    },
    accounts: { listIds: async () => [] },
    graceMs: 1,
    intervalMs: 1000,
    batchSize: 1,
  })
  const logger = {
    ...silentLogger(),
    warn: (message: string) => {
      warnings.push(message)
    },
  }
  const context = { now: NOW, logger, signal: new AbortController().signal }
  expect(await task.run(context)).toEqual({ outcome: "partial", itemsProcessed: 0 })
  expect(warnings).toEqual(["orphaned claude config directory cleanup deferred"])
  held = false
  expect(await task.run(context)).toEqual({ outcome: "success", itemsProcessed: 1 })
  expect(attempts).toBe(2)
  expect(warnings[1]).toBe("orphaned claude config directory removed")
})
