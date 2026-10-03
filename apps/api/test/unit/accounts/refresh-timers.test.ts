import { describe, expect, test } from "bun:test"
import { writeStoredOAuth } from "../../../src/services/accounts"
import {
  accountRow,
  CIPHER,
  deferred,
  fakeAccounts,
  harness,
  NOW,
  tokenResponse,
  until,
} from "./refresh-fixtures"

describe("timer identity and ownership", () => {
  test("unchanged credential sync holds its original due instant", async () => {
    const h = harness([accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })])
    await h.refresher.start()
    const original = h.scheduled[0]
    h.clock.now = new Date(NOW.getTime() + 10_000)
    await h.refresher.sync("acct-1")
    expect(h.scheduled.length).toBe(1)
    expect(h.scheduled[0]).toBe(original)
    expect(h.schedule.delays()).toEqual([75_000])
  })

  test("canceled callback cannot erase a replacement timer or fetch", async () => {
    const h = harness([accountRow()])
    await h.refresher.start()
    const stale = h.scheduled[0]
    h.rows[0] = accountRow({
      authMaterial: CIPHER.encrypt(
        writeStoredOAuth({
          accessToken: "replacement",
          refreshToken: "R2",
          providerAccountId: "identity-1",
        }),
      ),
    })
    await h.refresher.sync("acct-1")
    const replacement = h.scheduled.at(-1)
    stale?.run()
    expect(replacement?.cancelled).toBe(false)
    expect(h.schedule.count()).toBe(1)
    expect(h.upstream.calls()).toBe(0)
  })

  test("new identity sync during an old flight survives the old CAS miss", async () => {
    const h = harness([accountRow()])
    const issuer = h.upstream.pause()
    const flight = h.refresher.refreshNow("acct-1")
    await until(() => h.upstream.calls() === 1)
    h.rows[0] = accountRow({
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
    issuer.resolve(
      tokenResponse({ access_token: "stale", refresh_token: "stale-R", expires_in: 1 }),
    )
    expect(await flight).toMatchObject({ kind: "skipped", reason: "superseded" })
    expect(replacement?.cancelled).toBe(false)
    expect(h.schedule.count()).toBe(1)
  })

  test("same-token sync preserves transient retry budget", async () => {
    const h = harness([accountRow()], { maxAttempts: 2 })
    h.upstream.respondWith(async () => {
      throw new Error("offline")
    })
    await h.refresher.refreshNow("acct-1")
    await h.refresher.sync("acct-1")
    await h.refresher.refreshNow("acct-1")
    expect(h.rows[0]?.status).toBe("needs_reauth")
    expect(h.events.length).toBe(1)
  })

  test("busy admission rearms at the configured floor without failure budget", async () => {
    const h = harness(
      [accountRow()],
      {},
      { refreshLock: { tryRun: async () => ({ acquired: false, reason: "busy" }) } },
    )
    await h.refresher.start()
    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
      kind: "skipped",
      reason: "busy",
    })
    expect(h.schedule.delays()).toEqual([1_000])
    expect(h.events).toEqual([])
  })

  test("stopped refresher never admits another provider exchange", async () => {
    const h = harness([accountRow()])
    await h.refresher.stop()
    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
      kind: "skipped",
      reason: "aborted",
    })
    expect(h.upstream.calls()).toBe(0)
  })
  test("a delayed earlier sync cannot install its stale credential after a newer sync", async () => {
    const rows = [accountRow()]
    const repository = fakeAccounts(rows)
    const pending = deferred<ReturnType<typeof accountRow>>()
    let reads = 0
    const h = harness(
      rows,
      {},
      {
        accounts: {
          ...repository,
          findById: async (id) => (++reads === 1 ? pending.promise : repository.findById(id)),
        },
      },
    )
    await h.refresher.start()
    const stale = rows[0] as ReturnType<typeof accountRow>
    const oldSync = h.refresher.sync("acct-1")
    rows[0] = accountRow({
      authMaterial: CIPHER.encrypt(
        writeStoredOAuth({
          accessToken: "new-login",
          refreshToken: "R2",
          providerAccountId: "identity-1",
        }),
      ),
    })
    await h.refresher.sync("acct-1")
    const replacement = h.scheduled.at(-1)
    pending.resolve(stale)
    await oldSync
    expect(replacement?.cancelled).toBe(false)
    expect(h.schedule.count()).toBe(1)
  })
})

test("a recheck racing failure parking CAS resumes at the floor after final reconciliation", async () => {
  const rows = [accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })]
  const repository = fakeAccounts(rows)
  const h = harness(
    rows,
    {},
    {
      accounts: {
        ...repository,
        transitionObservedStatus: async () => {
          rows[0] = accountRow({ ...rows[0], lifecycleVersion: 1, healthRecoveryVersion: 1 })
          return undefined
        },
      },
    },
  )
  h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
  await h.refresher.start()
  h.clock.now = new Date(NOW.getTime() + 75_000)
  h.schedule.fireAll()
  expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
    kind: "skipped",
    reason: "superseded",
  })
  expect(h.schedule.delays()).toEqual([1_000])
  expect(h.upstream.calls()).toBe(1)
  expect(h.events).toEqual([])
  await h.refresher.stop()
})

test("exhausted terminal refresh failure pauses unchanged grant until explicit lifecycle recovery", async () => {
  const h = harness([
    accountRow({ status: "exhausted", tokenExpiresAt: new Date(NOW.getTime() + 100_000) }),
  ])
  h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
  await h.refresher.start()
  h.clock.now = new Date(NOW.getTime() + 75_000)
  h.schedule.fireAll()
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("failure")
  expect(h.rows[0]?.status).toBe("exhausted")
  expect(h.schedule.count()).toBe(0)
  await h.refresher.sync("acct-1")
  expect(h.schedule.count()).toBe(0)
  expect(h.events).toEqual([])
  h.rows[0] = accountRow({
    ...h.rows[0],
    status: "active",
    lifecycleVersion: 1,
    healthRecoveryVersion: 1,
  })
  await h.refresher.sync("acct-1")
  expect(h.schedule.delays()).toEqual([1_000])
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})

test("exhausted transient failure pauses only after the configured retry budget", async () => {
  const h = harness([accountRow({ status: "exhausted" })], { maxAttempts: 2 })
  h.upstream.respondWith(async () => {
    throw new Error("offline")
  })
  await h.refresher.refreshNow("acct-1")
  expect(h.schedule.delays()).toEqual([1_000])
  await h.refresher.refreshNow("acct-1")
  expect(h.rows[0]?.status).toBe("exhausted")
  expect(h.schedule.count()).toBe(0)
  await h.refresher.sync("acct-1")
  expect(h.schedule.count()).toBe(0)
  expect(h.upstream.calls()).toBe(2)
  expect(h.events).toEqual([])
  await h.refresher.stop()
})

test("lifecycle change during issuer refusal resumes only after the configured floor", async () => {
  const h = harness([accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })])
  const issuer = h.upstream.pause()
  await h.refresher.start()
  h.clock.now = new Date(NOW.getTime() + 75_000)
  h.schedule.fireAll()
  await until(() => h.upstream.calls() === 1)
  h.rows[0] = accountRow({ ...h.rows[0], lifecycleVersion: 1, healthRecoveryVersion: 1 })
  issuer.resolve(tokenResponse({ error: "invalid_grant" }, 400))
  expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
    kind: "skipped",
    reason: "superseded",
  })
  expect(h.schedule.delays()).toEqual([1_000])
  expect(h.events).toEqual([])
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})
