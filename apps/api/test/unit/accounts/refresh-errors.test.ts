import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { writeStoredOAuth } from "../../../src/services/accounts"
import { accountRow, CIPHER, deferred, fakeAccounts, harness, NOW, until } from "./refresh-fixtures"

function errorLog() {
  const lines: string[] = []
  return { lines, logger: createLogger({ level: "warn", write: (line) => lines.push(line) }) }
}
async function fireDue(h: ReturnType<typeof harness>): Promise<void> {
  await h.refresher.start()
  h.clock.now = new Date(NOW.getTime() + 75_000)
  h.schedule.fireAll()
}

test("fired timer DB read failure and failed final sync retain a floor retry", async () => {
  const rows = [accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })]
  const repository = fakeAccounts(rows)
  const log = errorLog()
  let unavailable = true
  const h = harness(
    rows,
    {},
    {
      logger: log.logger,
      accounts: {
        ...repository,
        findById: async (id) => {
          if (unavailable) throw new Error("temporary database failure")
          return repository.findById(id)
        },
      },
    },
  )
  await fireDue(h)
  await until(() => log.lines.some((line) => line.includes("credential refresh raised")))
  expect(h.schedule.delays()).toEqual([1_000])
  expect(h.upstream.calls()).toBe(0)
  unavailable = false
  h.clock.now = new Date(NOW.getTime() + 76_000)
  h.schedule.fireAll()
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("success")
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})

test("parsed rotated grant followed by failed credential CAS pauses the old identity", async () => {
  const rows = [accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })]
  const repository = fakeAccounts(rows)
  const log = errorLog()
  const h = harness(
    rows,
    {},
    {
      logger: log.logger,
      accounts: {
        ...repository,
        saveRefreshedCredential: async () => {
          throw new Error("ambiguous writeback")
        },
      },
    },
  )
  await fireDue(h)
  await until(() => log.lines.some((line) => line.includes("credential refresh raised")))
  expect(h.schedule.count()).toBe(0)
  await h.refresher.sync("acct-1")
  expect(h.schedule.count()).toBe(0)
  rows[0] = accountRow({ ...rows[0], lifecycleVersion: 1, status: "disabled" })
  await h.refresher.sync("acct-1")
  rows[0] = accountRow({ ...rows[0], lifecycleVersion: 2, status: "active" })
  await h.refresher.sync("acct-1")
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("skipped")
  await h.refresher.stop()
  await h.refresher.start()
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("skipped")
  expect(h.schedule.count()).toBe(0)
  expect(h.upstream.calls()).toBe(1)
  expect(h.events).toEqual([])
  await h.refresher.stop()
})

test("CAS committed R2 before an acknowledgment error schedules the committed identity", async () => {
  const rows = [accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })]
  const repository = fakeAccounts(rows)
  const log = errorLog()
  const h = harness(
    rows,
    {},
    {
      logger: log.logger,
      accounts: {
        ...repository,
        saveRefreshedCredential: async (input) => {
          await repository.saveRefreshedCredential(input)
          throw new Error("acknowledgment lost")
        },
      },
    },
  )
  await fireDue(h)
  await until(() => log.lines.some((line) => line.includes("credential refresh raised")))
  expect(h.schedule.count()).toBe(1)
  expect(h.schedule.delays()).toEqual([2_700_000])
  expect(h.barriers()).toBe(1)
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})

test("an old ambiguous CAS failure cannot pause a replacement credential timer", async () => {
  const rows = [accountRow()]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const permit = deferred<void>()
  const h = harness(
    rows,
    {},
    {
      accounts: {
        ...repository,
        saveRefreshedCredential: async () => {
          entered.resolve()
          await permit.promise
          throw new Error("old ambiguous writeback")
        },
      },
    },
  )
  const flight = h.refresher.refreshNow("acct-1")
  const rejected = flight.catch((error: unknown) => error)
  await entered.promise
  rows[0] = accountRow({
    lifecycleVersion: 1,
    authMaterial: CIPHER.encrypt(
      writeStoredOAuth({
        accessToken: "new-login",
        refreshToken: "new-login-R",
        providerAccountId: "identity-1",
      }),
    ),
  })
  await h.refresher.sync("acct-1")
  const replacement = h.scheduled.at(-1)
  permit.resolve()
  expect(await rejected).toBeInstanceOf(Error)
  expect(replacement?.cancelled).toBe(false)
  expect(h.schedule.count()).toBe(1)
  await h.refresher.stop()
})

test("stale exhausted failure cannot disarm a replacement timer", async () => {
  const rows = [accountRow({ status: "exhausted" })]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const release = deferred<void>()
  let reads = 0
  const h = harness(
    rows,
    {},
    {
      fetch: async () => new Response("refused", { status: 401 }),
      accounts: {
        ...repository,
        findById: async (id) => {
          const row = await repository.findById(id)
          if (++reads === 3) {
            entered.resolve()
            await release.promise
          }
          return row
        },
      },
    },
  )
  const flight = h.refresher.refreshNow("acct-1")
  await entered.promise
  rows[0] = accountRow({
    lifecycleVersion: 1,
    authMaterial: CIPHER.encrypt(
      writeStoredOAuth({
        accessToken: "replacement",
        refreshToken: "new-R",
        providerAccountId: "identity-1",
      }),
    ),
  })
  await h.refresher.sync("acct-1")
  const timer = h.scheduled.at(-1)
  release.resolve()
  expect((await flight).kind).toBe("skipped")
  expect(timer?.cancelled).toBe(false)
  expect(h.schedule.count()).toBe(1)
  await h.refresher.stop()
})

test("same ciphertext expiry edit cannot escape uncertain grant quarantine", async () => {
  const rows = [accountRow()]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const release = deferred<void>()
  const h = harness(
    rows,
    {},
    {
      accounts: {
        ...repository,
        saveRefreshedCredential: async () => {
          entered.resolve()
          await release.promise
          throw new Error("ambiguous")
        },
      },
    },
  )
  const flight = h.refresher.refreshNow("acct-1").catch((error: unknown) => error)
  await entered.promise
  rows[0] = accountRow({
    ...rows[0],
    lifecycleVersion: 1,
    tokenExpiresAt: new Date(NOW.getTime() + 7_200_000),
  })
  await h.refresher.sync("acct-1")
  release.resolve()
  expect(await flight).toBeInstanceOf(Error)
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("skipped")
  expect(h.schedule.count()).toBe(0)
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})

test("writeback failure during shutdown retains quarantine on restart", async () => {
  const rows = [accountRow()]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const release = deferred<void>()
  const h = harness(
    rows,
    {},
    {
      accounts: {
        ...repository,
        saveRefreshedCredential: async () => {
          entered.resolve()
          await release.promise
          throw new Error("shutdown writeback uncertain")
        },
      },
    },
  )
  const flight = h.refresher.refreshNow("acct-1").catch((error: unknown) => error)
  await entered.promise
  const stopping = h.refresher.stop()
  release.resolve()
  expect(await flight).toBeInstanceOf(Error)
  await stopping
  await h.refresher.start()
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("skipped")
  expect(h.schedule.count()).toBe(0)
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})
test("acknowledgment loss waits for strict catalog and shutdown bounds that wait", async () => {
  const rows = [accountRow()]
  const repository = fakeAccounts(rows)
  const entered = deferred<void>()
  const release = deferred<void>()
  let visible: string | null = null
  const h = harness(
    rows,
    { shutdownDrainMs: 25 },
    {
      accounts: {
        ...repository,
        saveRefreshedCredential: async (input) => {
          await repository.saveRefreshedCredential(input)
          throw new Error("ack lost")
        },
      },
      refreshCatalogAfterMutation: async () => {
        visible = rows[0]?.authMaterial ?? null
        entered.resolve()
        await release.promise
      },
    },
  )
  let settled = false
  const flight = h.refresher.refreshNow("acct-1").catch(() => {
    settled = true
  })
  await entered.promise
  expect(visible).toBe(rows[0]?.authMaterial ?? null)
  expect(settled).toBe(false)
  const stopping = h.refresher.stop()
  h.scheduled.findLast((call) => call.delay === 25 && !call.cancelled)?.run()
  await stopping
  expect(settled).toBe(false)
  release.resolve()
  await flight
  expect(h.upstream.calls()).toBe(1)
})
