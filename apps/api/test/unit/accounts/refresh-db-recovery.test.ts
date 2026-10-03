import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import {
  accountRow,
  deferred,
  fakeAccounts,
  harness,
  NOW,
  tokenResponse,
  until,
} from "./refresh-fixtures"

for (const succeeds of [false, true]) {
  test(`${succeeds ? "committed rotation" : "finished refusal"} retains floor timer when final DB reads fail`, async () => {
    const rows = [accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })]
    const repository = fakeAccounts(rows)
    let readsFail = false
    let exchanges = 0
    const lines: string[] = []
    const h = harness(
      rows,
      {},
      {
        logger: createLogger({ level: "warn", write: (line) => lines.push(line) }),
        accounts: {
          ...repository,
          findById: async (id) => {
            if (readsFail) throw new Error("database unavailable after issuer response")
            return repository.findById(id)
          },
        },
        fetch: async () => {
          exchanges++
          readsFail = true
          return succeeds
            ? tokenResponse({ access_token: "R2-access", refresh_token: "R2", expires_in: 3600 })
            : tokenResponse({ error: "invalid_grant" }, 400)
        },
      },
    )
    await h.refresher.start()
    h.clock.now = new Date(NOW.getTime() + 75_000)
    h.schedule.fireAll()
    await until(() =>
      lines.some((line) =>
        line.includes(succeeds ? "could not reconcile" : "credential refresh raised"),
      ),
    )
    expect(h.schedule.delays()).toEqual([1000])
    readsFail = false
    if (succeeds) {
      h.clock.now = new Date(NOW.getTime() + 76_000)
      h.schedule.fireAll()
      expect((await h.refresher.refreshNow("acct-1")).kind).toBe("skipped")
      expect(exchanges).toBe(1)
    } else await h.refresher.sync("acct-1")
    expect(h.schedule.delays()).toEqual([succeeds ? 2_699_250 : 1000])
    await h.refresher.stop()
  })
}

test("latest public read failure restores a timer when overlapping settling read also fails", async () => {
  const rows = [accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })]
  const repository = fakeAccounts(rows)
  const settlingEntered = deferred<void>()
  const settlingFail = deferred<void>()
  const publicFail = deferred<void>()
  let reads = 0
  const h = harness(
    rows,
    {},
    {
      accounts: {
        ...repository,
        findById: async (id) => {
          const count = ++reads
          if (count === 2) {
            settlingEntered.resolve()
            await settlingFail.promise
            throw new Error("settling failed")
          }
          if (count === 3) {
            await publicFail.promise
            throw new Error("public failed")
          }
          return repository.findById(id)
        },
      },
    },
  )
  await h.refresher.start()
  h.clock.now = new Date(NOW.getTime() + 75_000)
  h.schedule.fireAll()
  await settlingEntered.promise
  const publicSync = h.refresher.sync("acct-1")
  settlingFail.resolve()
  await Promise.resolve()
  publicFail.resolve()
  await publicSync
  expect(h.schedule.delays()).toEqual([1000])
  await h.refresher.stop()
})

test("newer successful public sync owns timer after stale settling read returns", async () => {
  const rows = [
    accountRow({ status: "exhausted", tokenExpiresAt: new Date(NOW.getTime() + 100_000) }),
  ]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const release = deferred<void>()
  let reads = 0
  const h = harness(
    rows,
    {},
    {
      accounts: {
        ...repository,
        findById: async (id) => {
          const row = await repository.findById(id)
          if (++reads === 4) {
            entered.resolve()
            await release.promise
          }
          return row
        },
      },
      fetch: async () => tokenResponse({ error: "invalid_grant" }, 400),
    },
  )
  h.clock.now = new Date(NOW.getTime() + 100_000)
  const flight = h.refresher.refreshNow("acct-1")
  await entered.promise
  rows[0] = accountRow({ ...rows[0], status: "active", lifecycleVersion: 1 })
  await h.refresher.sync("acct-1")
  expect(h.schedule.count()).toBe(0)
  release.resolve()
  await flight
  expect(h.schedule.count()).toBe(1)
  expect(h.schedule.delays()).toEqual([1000])
  await h.refresher.stop()
})
