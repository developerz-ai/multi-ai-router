import { describe, expect, test } from "bun:test"
import { credentialFingerprint } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { accountRow, harness, NOW, spentParked, tokenResponse } from "./refresh-fixtures"

/**
 * Prod, 2026-11-06 13:28:24Z, a customer deployment: an openai-oauth account answered 401 "Your authentication
 * token has expired. Please try refreshing it." with a stored expiry a week ahead, and was parked
 * `needs_reauth` with no refresh attempted. The expiry timer could never have fired.
 */
const WEEK_AHEAD = new Date(NOW.getTime() + 7 * 24 * 3_600_000)
const parked = () => accountRow({ status: "needs_reauth", tokenExpiresAt: WEEK_AHEAD })
const settle = async () => {
  for (let i = 0; i < 5; i++) await Bun.sleep(0)
}

describe("a parked account's one refresh", () => {
  test("a working refresh token returns it to service with no operator action", async () => {
    const h = harness([parked()])

    const outcome = await h.refresher.refreshNow("acct-1")

    expect(outcome.kind).toBe("success")
    expect(h.upstream.calls()).toBe(1)
    expect(h.rows[0]?.status).toBe("active")
    expect(h.barriers()).toBeGreaterThan(0)
    expect(h.events).toMatchObject([
      {
        kind: "account.reauthorized",
        subjectId: "acct-1",
        detail: { source: "credential_refresh", previousStatus: "needs_reauth" },
      },
    ])
  })

  test("a refused refresh leaves it needs_reauth, audited, and spent", async () => {
    const h = harness([parked()])
    h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))

    const outcome = await h.refresher.refreshNow("acct-1")

    expect(outcome.kind).toBe("failure")
    expect(h.upstream.calls()).toBe(1)
    expect(h.rows[0]?.status).toBe("needs_reauth")
    expect(h.events).toMatchObject([
      { kind: "account.updated", detail: { source: "credential_refresh", reason: "refused" } },
    ])
    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({ reason: "not-refreshable" })
    expect(h.upstream.calls()).toBe(1)
  })

  test("an unreachable issuer is retried on the backoff, then spent", async () => {
    const h = harness([parked()], { maxAttempts: 2 })
    h.upstream.respondWith(async () => tokenResponse({ error: "down" }, 503))

    await h.refresher.refreshNow("acct-1")
    expect(h.rows[0]?.authRefreshSpentOn).toBeNull()

    h.clock.now = new Date(NOW.getTime() + 60_000)
    h.schedule.fireAll()
    await settle()

    expect(h.upstream.calls()).toBe(2)
    expect(h.rows[0]?.status).toBe("needs_reauth")
    expect(h.rows[0]?.authRefreshSpentOn).toBe(credentialFingerprint(h.rows[0]?.authMaterial ?? ""))
    expect(h.schedule.count()).toBe(0)
  })

  test("boot gives an account parked before this existed one attempt", async () => {
    const h = harness([parked()])

    await h.refresher.start()
    h.clock.now = new Date(NOW.getTime() + 1_000)
    h.schedule.fireAll()
    await settle()

    expect(h.upstream.calls()).toBe(1)
    expect(h.rows[0]?.status).toBe("active")
    await h.refresher.stop()
  })

  test("a parked row with no stored expiry still gets its attempt at boot", async () => {
    const h = harness([accountRow({ status: "needs_reauth", tokenExpiresAt: null })])

    await h.refresher.start()

    expect(h.schedule.delays()).toEqual([1_000])
    await h.refresher.stop()
  })

  test("a second boot does not retry a failed attempt", async () => {
    const h = harness([parked()])
    h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
    await h.refresher.refreshNow("acct-1")
    await h.refresher.stop()

    await h.refresher.start()

    expect(h.schedule.count()).toBe(0)
    expect(h.upstream.calls()).toBe(1)
    await h.refresher.stop()
  })
})

describe("one refresh per credential generation, not one per 401", () => {
  test("a provider refusing every token cannot loop: the refreshed credential is born spent", async () => {
    const h = harness([parked()])
    await h.refresher.refreshNow("acct-1")
    expect(h.rows[0]?.status).toBe("active")

    // The next 401 lands on the credential the refresh produced, and the writer parks it again.
    const held = h.rows[0]
    if (held === undefined) throw new Error("row vanished")
    h.rows[0] = { ...held, status: "needs_reauth" }
    const outcome = await h.refresher.refreshNow("acct-1")

    expect(outcome).toMatchObject({ kind: "skipped", reason: "not-refreshable" })
    expect(h.upstream.calls()).toBe(1)
    expect(h.rows[0]?.status).toBe("needs_reauth")
  })

  test("concurrent reports of one parked account share one exchange", async () => {
    const h = harness([parked()])
    const paused = h.upstream.pause()

    const flights = [h.refresher.refreshNow("acct-1"), h.refresher.refreshNow("acct-1")]
    await settle()
    paused.resolve(tokenResponse({ access_token: "a", refresh_token: "b", expires_in: 3_600 }))
    await Promise.all(flights)

    expect(h.upstream.calls()).toBe(1)
  })

  test("the expiry timer's ordinary refresh starts a new generation", async () => {
    const h = harness([spentParked({ status: "active" })])
    await h.refresher.refreshNow("acct-1")

    const held = h.rows[0]
    if (held === undefined) throw new Error("row vanished")
    h.rows[0] = { ...held, status: "needs_reauth" }

    expect((await h.refresher.refreshNow("acct-1")).kind).toBe("success")
    expect(h.upstream.calls()).toBe(2)
  })

  test("a failed expiry refresh is that credential's one attempt", async () => {
    const h = harness([accountRow()])
    h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))

    await h.refresher.refreshNow("acct-1")

    expect(h.rows[0]?.status).toBe("needs_reauth")
    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({ reason: "not-refreshable" })
    expect(h.upstream.calls()).toBe(1)
  })
})

describe("the operator's re-check", () => {
  test("buys one more attempt on a spent credential", async () => {
    const h = harness([spentParked()])

    expect((await h.refresher.retryParked("acct-1")).kind).toBe("success")

    expect(h.upstream.calls()).toBe(1)
    expect(h.rows[0]?.status).toBe("active")
  })

  test("and only one: a refused attempt is spent again", async () => {
    const h = harness([spentParked()])
    h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))

    await h.refresher.retryParked("acct-1")

    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({ reason: "not-refreshable" })
    expect(h.upstream.calls()).toBe(1)
  })

  test("leaves anything that is not parked alone", async () => {
    const h = harness([accountRow({ status: "exhausted" })])

    expect(await h.refresher.retryParked("acct-1")).toMatchObject({ reason: "not-refreshable" })
    expect(h.upstream.calls()).toBe(0)
  })
})

describe("what stays out of it", () => {
  test("a Claude subscription: its refresh token belongs to the SDK", async () => {
    const row = accountRow({ provider: "anthropic-oauth", status: "needs_reauth" })
    const h = harness([row])

    await h.refresher.start()
    expect(h.schedule.count()).toBe(0)
    expect(await h.refresher.refreshNow(row.id)).toMatchObject({ reason: "not-refreshable" })
    expect(await h.refresher.retryParked(row.id)).toMatchObject({ reason: "not-refreshable" })

    expect(h.upstream.calls()).toBe(0)
    expect(h.rows[0]?.status).toBe("needs_reauth")
    await h.refresher.stop()
  })

  test("an operator's disabled account", async () => {
    const h = harness([accountRow({ status: "disabled" })])

    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({ reason: "not-refreshable" })
    expect(h.upstream.calls()).toBe(0)
  })

  test("token material, from every line and audit row of both outcomes", async () => {
    const lines: string[] = []
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) })
    const good = harness([parked()], {}, { logger })
    await good.refresher.refreshNow("acct-1")
    const bad = harness([parked()], {}, { logger })
    bad.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
    await bad.refresher.refreshNow("acct-1")

    const trail = JSON.stringify([lines, good.events, bad.events])
    expect(lines.length).toBeGreaterThan(0)
    for (const secret of ["old-access", "rt-1", "new-access", "rt-2"])
      expect(trail).not.toContain(secret)
  })
})
