import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { readStoredOAuth } from "../../../src/services/accounts"
import {
  accountRow,
  CIPHER,
  deferred,
  fakeAccounts,
  harness,
  tokenResponse,
  until,
} from "./refresh-fixtures"

function expireDrain(h: ReturnType<typeof harness>): void {
  const timeout = h.scheduled.find((timer) => timer.delay === 20 && !timer.cancelled)
  expect(timeout).toBeDefined()
  timeout?.run()
}

test("shutdown bounds stalled parsed-token CAS and suppresses subsequent catalog work", async () => {
  const rows = [accountRow()]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const permit = deferred<void>()
  let barriers = 0
  const logs: string[] = []
  const h = harness(
    rows,
    { shutdownDrainMs: 20 },
    {
      accounts: {
        ...repository,
        saveRefreshedCredential: async (input) => {
          entered.resolve()
          await permit.promise
          return repository.saveRefreshedCredential(input)
        },
      },
      refreshCatalogAfterMutation: async () => {
        barriers++
      },
      logger: createLogger({ level: "warn", write: (line) => logs.push(line) }),
    },
  )
  const flight = h.refresher.refreshNow("acct-1")
  await entered.promise
  const stop = h.refresher.stop()
  expireDrain(h)
  await stop
  expect(logs.join("\n")).toContain("grant persistence is uncertain")
  expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
    kind: "skipped",
    reason: "aborted",
  })
  permit.resolve()
  await flight
  expect(barriers).toBe(0)
  expect(h.schedule.count()).toBe(0)
})

test("parsed rotation completing within the drain deadline is saved and reconciled", async () => {
  const rows = [accountRow()]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const permit = deferred<void>()
  const h = harness(
    rows,
    { shutdownDrainMs: 20 },
    {
      accounts: {
        ...repository,
        saveRefreshedCredential: async (input) => {
          entered.resolve()
          await permit.promise
          return repository.saveRefreshedCredential(input)
        },
      },
    },
  )
  const flight = h.refresher.refreshNow("acct-1")
  await entered.promise
  const stop = h.refresher.stop()
  permit.resolve()
  await stop
  expect((await flight).kind).toBe("success")
  expect(readStoredOAuth(CIPHER.decrypt(rows[0]?.authMaterial as string))?.refreshToken).toBe(
    "rt-2",
  )
  expect(h.barriers()).toBe(1)
  expect(h.schedule.count()).toBe(0)
})

test("shutdown bounds a stalled credential catalog barrier", async () => {
  const entered = deferred<void>()
  const permit = deferred<void>()
  const h = harness(
    [accountRow()],
    { shutdownDrainMs: 20 },
    {
      refreshCatalogAfterMutation: async () => {
        entered.resolve()
        await permit.promise
      },
    },
  )
  const flight = h.refresher.refreshNow("acct-1")
  await entered.promise
  const stop = h.refresher.stop()
  expireDrain(h)
  await stop
  expect(h.upstream.calls()).toBe(1)
  permit.resolve()
  await flight
  expect(h.schedule.count()).toBe(0)
})

test("shutdown bounds a stalled parking audit after installing its catalog", async () => {
  const entered = deferred<void>()
  const permit = deferred<void>()
  const h = harness(
    [accountRow()],
    { shutdownDrainMs: 20 },
    {
      audit: {
        record: async () => {
          entered.resolve()
          await permit.promise
        },
      },
    },
  )
  h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
  const flight = h.refresher.refreshNow("acct-1")
  await entered.promise
  expect(h.barriers()).toBe(1)
  const stop = h.refresher.stop()
  expireDrain(h)
  await stop
  permit.resolve()
  await flight
  expect(h.schedule.count()).toBe(0)
})

test("shutdown bounds a stalled catalog-only retry and never exchanges another grant", async () => {
  const permit = deferred<void>()
  let calls = 0
  const h = harness(
    [accountRow()],
    { shutdownDrainMs: 20 },
    {
      refreshCatalogAfterMutation: async () => {
        if (++calls === 1) throw new Error("offline")
        await permit.promise
      },
    },
  )
  await h.refresher.refreshNow("acct-1")
  const retry = h.scheduled.find((timer) => timer.delay === 1_000 && !timer.cancelled)
  retry?.run()
  await until(() => calls === 2)
  const stop = h.refresher.stop()
  expireDrain(h)
  await stop
  expect(h.upstream.calls()).toBe(1)
  permit.resolve()
})
