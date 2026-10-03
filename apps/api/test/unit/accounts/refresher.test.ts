import { describe, expect, test } from "bun:test"
import { writeStoredOAuth } from "../../../src/services/accounts"
import { accountRow, CIPHER, harness, NOW, tokenResponse } from "./refresh-fixtures"

describe("arming, driven by the clock", () => {
  test("arms at a fraction of the remaining lifetime, not a fixed lead", async () => {
    const row = accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })
    const h = harness([row], { leadFraction: 0.75, minDelayMs: 1_000 })

    await h.refresher.start()

    expect(h.schedule.delays()).toEqual([75_000])
  })

  test("the floor stops a near-expired token from spinning", async () => {
    const row = accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100) })
    const h = harness([row], { leadFraction: 0.75, minDelayMs: 5_000 })

    await h.refresher.start()

    expect(h.schedule.delays()).toEqual([5_000])
  })

  test("arms nothing for an account with no HTTP OAuth flow (Claude subscriptions)", async () => {
    const row = accountRow({
      provider: "anthropic-oauth",
      tokenExpiresAt: new Date(NOW.getTime() + 100_000),
    })
    const h = harness([row])

    await h.refresher.start()

    expect(h.schedule.count()).toBe(0)
  })

  test("arms nothing for a disabled account, or one already needing reauth", async () => {
    const disabled = accountRow({ id: "d", status: "disabled" })
    const needsReauth = accountRow({ id: "n", status: "needs_reauth" })
    const h = harness([disabled, needsReauth])

    await h.refresher.start()

    expect(h.schedule.count()).toBe(0)
  })

  test("arms nothing for an account with no expiry to schedule against", async () => {
    const row = accountRow({ tokenExpiresAt: null })
    const h = harness([row])

    await h.refresher.start()

    expect(h.schedule.count()).toBe(0)
  })
})

describe("single-flight under concurrent triggers", () => {
  test("two simultaneous callers await one exchange and write one row", async () => {
    const row = accountRow()
    const h = harness([row])

    const [first, second] = await Promise.all([
      h.refresher.refreshNow(row.id),
      h.refresher.refreshNow(row.id),
    ])

    expect(h.upstream.calls()).toBe(1)
    expect(first).toEqual(second)
    expect(first.kind).toBe("success")
  })

  test("a caller that triggers again after the first settles gets a fresh exchange", async () => {
    const row = accountRow()
    const h = harness([row])

    await h.refresher.refreshNow(row.id)
    await h.refresher.refreshNow(row.id)

    expect(h.upstream.calls()).toBe(2)
  })

  test("concurrency between different accounts is untouched", async () => {
    const rowA = accountRow({ id: "a" })
    const rowB = accountRow({ id: "b" })
    const h = harness([rowA, rowB])

    await Promise.all([h.refresher.refreshNow("a"), h.refresher.refreshNow("b")])

    expect(h.upstream.calls()).toBe(2)
  })
})

describe("failure never fails a request — it parks the account", () => {
  test("a transient failure retries before giving up, and never throws", async () => {
    const row = accountRow()
    const h = harness([row], { maxAttempts: 2 })
    h.upstream.respondWith(async () => {
      throw new Error("network down")
    })

    const first = await h.refresher.refreshNow(row.id)
    expect(first).toMatchObject({ kind: "failure", reason: "unreachable" })
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("active")

    const second = await h.refresher.refreshNow(row.id)
    expect(second).toMatchObject({ kind: "failure", reason: "unreachable" })
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("needs_reauth")
    expect(h.events.at(-1)).toMatchObject({
      kind: "account.updated",
      detail: { status: "needs_reauth", reason: "unreachable" },
    })
  })

  test("a refused exchange parks immediately — a clock will not fix a rejected refresh token", async () => {
    const row = accountRow()
    const h = harness([row], { maxAttempts: 5 })
    h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))

    const outcome = await h.refresher.refreshNow(row.id)

    expect(outcome).toMatchObject({ kind: "failure", reason: "refused" })
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("needs_reauth")
  })

  test("no refresh token at all is refused, not retried", async () => {
    const row = accountRow({
      authMaterial: CIPHER.encrypt(
        writeStoredOAuth({ accessToken: "a", refreshToken: null, providerAccountId: "identity-1" }),
      ),
    })
    const h = harness([row], { maxAttempts: 5 })

    const outcome = await h.refresher.refreshNow(row.id)

    expect(outcome).toMatchObject({ kind: "failure", reason: "no-refresh-token" })
    expect(h.upstream.calls()).toBe(0)
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("needs_reauth")
  })

  test("a disabled account is left alone: disabled is the operator's word", async () => {
    const row = accountRow({ status: "disabled" })
    const h = harness([row])

    const outcome = await h.refresher.refreshNow(row.id)

    expect(outcome).toMatchObject({ kind: "skipped", reason: "not-refreshable" })
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("disabled")
  })

  test("a parked account requires an explicit authorization", async () => {
    const row = accountRow({ status: "needs_reauth" })
    const h = harness([row])
    expect(await h.refresher.refreshNow(row.id)).toMatchObject({
      kind: "skipped",
      reason: "not-refreshable",
    })
    expect(h.rows[0]?.status).toBe("needs_reauth")
    expect(h.upstream.calls()).toBe(0)
    expect(h.events).toEqual([])
  })
})

describe("credential material never leaks", () => {
  test("no refresh token or access token appears in an audit event", async () => {
    const row = accountRow()
    const h = harness([row])
    h.upstream.respondWith(async () => {
      throw new Error("network down")
    })

    await h.refresher.refreshNow(row.id)

    const serialized = JSON.stringify(h.events)
    expect(serialized).not.toContain("old-access")
    expect(serialized).not.toContain("rt-1")
    expect(serialized).not.toContain("new-access")
  })
})

describe("shutdown", () => {
  test("stop disarms every timer and awaits what is in flight", async () => {
    const row = accountRow()
    const h = harness([row])
    const control = h.upstream.pause()

    await h.refresher.start()
    const inFlight = h.refresher.refreshNow(row.id)
    const stopped = h.refresher.stop()

    control.resolve(tokenResponse({ access_token: "a", expires_in: 60 }))
    await Promise.all([inFlight, stopped])

    expect(h.schedule.count()).toBe(0)
  })
})
