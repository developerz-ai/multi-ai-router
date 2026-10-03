import { expect, test } from "bun:test"
import {
  createIdleAccountProbeTask,
  IDLE_PROBE_MODELS,
} from "../../../src/scheduler/tasks/idle-account-probe"
import { accountRow } from "../../support/account-row"
import { silentLogger } from "./fixtures"

const now = new Date()
const context = () => ({ now, logger: silentLogger(), signal: new AbortController().signal })
for (const status of ["disabled", "exhausted", "needs_reauth"] as const) {
  test(`a stale idle list cannot authorize a paid turn for ${status}`, async () => {
    const row = accountRow({ status, provider: "zai" })
    let paid = 0
    const task = createIdleAccountProbeTask({
      accounts: {
        list: async () => [row],
        findIdle: async () => [row],
        readEligibleBackgroundAccount: async () => undefined,
      },
      test: async () => {
        paid++
        return { tested: true, outcome: "ok" }
      },
      models: IDLE_PROBE_MODELS,
      intervalMs: 1000,
      idleAfterMs: 1000,
      batchSize: 1,
      paidTurn: true,
      warmCredentials: true,
    })
    await task.run(context())
    expect(paid).toBe(0)
  })
}
test("disable during a cold wait refuses warming using the captured original subject", async () => {
  const row = accountRow({ status: "active", provider: "anthropic-oauth", lifecycleVersion: 1 })
  let paid = 0,
    gauged = 0
  const task = createIdleAccountProbeTask({
    accounts: {
      list: async () => [row],
      findIdle: async () => [],
      readEligibleBackgroundAccount: async (_id, expected) =>
        row.status === "active" && row.lifecycleVersion === expected.lifecycleVersion
          ? row
          : undefined,
    },
    auth: {
      check: async () => ({
        loggedIn: true,
        email: null,
        subscriptionType: null,
        checkedAt: now.toISOString(),
        statusChangedTo: null,
      }),
    },
    cold: async () => {
      row.status = "disabled"
      row.lifecycleVersion++
      return true
    },
    usage: async () => {
      gauged++
      return "read"
    },
    test: async () => {
      paid++
      return { tested: true, outcome: "ok" }
    },
    models: IDLE_PROBE_MODELS,
    intervalMs: 1000,
    idleAfterMs: 1000,
    batchSize: 1,
    paidTurn: false,
    warmCredentials: true,
  })
  await task.run(context())
  expect(paid).toBe(0)
  expect(gauged).toBe(0)
})
test("an unsupported default Kimi model causes no billable maintenance request", async () => {
  const row = accountRow({ provider: "kimi", status: "active" })
  let paid = 0
  const task = createIdleAccountProbeTask({
    accounts: {
      list: async () => [row],
      findIdle: async () => [row],
      readEligibleBackgroundAccount: async () => row,
    },
    test: async () => {
      paid++
      return { tested: true, outcome: "ok" }
    },
    models: IDLE_PROBE_MODELS,
    intervalMs: 1000,
    idleAfterMs: 1000,
    batchSize: 1,
    paidTurn: true,
    warmCredentials: false,
  })
  await task.run(context())
  expect(paid).toBe(0)
  expect(IDLE_PROBE_MODELS.kimi).toBeUndefined()
})
