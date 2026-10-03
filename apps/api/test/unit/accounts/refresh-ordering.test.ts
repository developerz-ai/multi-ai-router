import { describe, expect, test } from "bun:test"
import type { CredentialRefreshLock } from "@multi-ai-router/db"
import { readStoredOAuth, writeStoredOAuth } from "../../../src/services/accounts"
import {
  accountRow,
  CIPHER,
  deferred,
  fakeAccounts,
  harness,
  tokenResponse,
  until,
} from "./refresh-fixtures"

describe("refresh observations and rotated grants", () => {
  test("disable during exchange saves rotation without changing CURRENT lifecycle/status", async () => {
    const h = harness([accountRow()])
    const issuer = h.upstream.pause()
    const flight = h.refresher.refreshNow("acct-1")
    await until(() => h.upstream.calls() === 1)
    h.rows[0] = accountRow({ ...h.rows[0], status: "disabled", lifecycleVersion: 1 })
    issuer.resolve(
      tokenResponse({ access_token: "opaque-new", refresh_token: "R2", expires_in: 60 }),
    )
    const outcome = await flight
    expect(outcome).toMatchObject({
      kind: "success",
      row: { status: "disabled", lifecycleVersion: 1 },
    })
    expect(readStoredOAuth(CIPHER.decrypt(h.rows[0]?.authMaterial as string))).toMatchObject({
      refreshToken: "R2",
    })
    expect(h.events).toEqual([])
    expect(h.schedule.count()).toBe(0)
    expect(h.barriers()).toBe(1)
  })

  test("new authorization fences old rotation and CAS miss never exchanges twice", async () => {
    const h = harness([accountRow()])
    const issuer = h.upstream.pause()
    const flight = h.refresher.refreshNow("acct-1")
    await until(() => h.upstream.calls() === 1)
    const fresh = CIPHER.encrypt(
      writeStoredOAuth({
        accessToken: "new-login",
        refreshToken: "new-login-R",
        providerAccountId: "new-account",
      }),
    )
    h.rows[0] = accountRow({ authMaterial: fresh, lifecycleVersion: 1, authRecoveryVersion: 1 })
    issuer.resolve(tokenResponse({ access_token: "stale-access", refresh_token: "stale-R" }))
    expect(await flight).toMatchObject({ kind: "skipped", reason: "superseded" })
    expect(h.rows[0]?.authMaterial).toBe(fresh)
    expect(h.upstream.calls()).toBe(1)
    expect(h.events).toEqual([])
  })

  test("a late refusal cannot overwrite operator disable or emit an audit", async () => {
    const h = harness([accountRow()])
    const issuer = h.upstream.pause()
    const flight = h.refresher.refreshNow("acct-1")
    await until(() => h.upstream.calls() === 1)
    h.rows[0] = accountRow({ status: "disabled", lifecycleVersion: 1 })
    issuer.resolve(tokenResponse({ error: "invalid_grant" }, 400))
    expect(await flight).toMatchObject({ kind: "skipped", reason: "superseded" })
    expect(h.rows[0]?.status).toBe("disabled")
    expect(h.events).toEqual([])
  })

  test("exhausted account token refresh preserves quota verdict", async () => {
    const h = harness([accountRow({ status: "exhausted" })])
    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
      kind: "success",
      row: { status: "exhausted" },
    })
    expect(h.events).toEqual([])
  })

  test("lock owner rereads identity before exchange", async () => {
    const acquired = deferred<void>()
    const rows = [accountRow()]
    const h = harness(
      rows,
      {},
      {
        refreshLock: {
          tryRun: async (_id, signal, work) => {
            await acquired.promise
            return { acquired: true, value: await work(signal) }
          },
        },
      },
    )
    const flight = h.refresher.refreshNow("acct-1")
    await Promise.resolve()
    rows[0] = accountRow({
      authMaterial: CIPHER.encrypt(
        writeStoredOAuth({
          accessToken: "new",
          refreshToken: "R2",
          providerAccountId: "identity-1",
        }),
      ),
    })
    acquired.resolve()
    expect(await flight).toMatchObject({ kind: "skipped", reason: "superseded" })
    expect(h.upstream.calls()).toBe(0)
  })

  test("two refreshers share rotating issuer and contention is neutral", async () => {
    let held = false
    const lock: CredentialRefreshLock = {
      tryRun: async (_id, signal, work) => {
        if (held) return { acquired: false, reason: "busy" }
        held = true
        try {
          return { acquired: true, value: await work(signal) }
        } finally {
          held = false
        }
      },
    }
    const rows = [accountRow()]
    const owner = harness(rows, {}, { refreshLock: lock })
    const peer = harness(rows, {}, { refreshLock: lock })
    const issuer = owner.upstream.pause()
    const flight = owner.refresher.refreshNow("acct-1")
    await until(() => owner.upstream.calls() === 1)
    expect(await peer.refresher.refreshNow("acct-1")).toMatchObject({
      kind: "skipped",
      reason: "busy",
    })
    issuer.resolve(tokenResponse({ access_token: "new", refresh_token: "R2", expires_in: 60 }))
    await flight
    expect(owner.upstream.calls() + peer.upstream.calls()).toBe(1)
    expect(peer.events).toEqual([])
    expect(rows[0]?.status).toBe("active")
  })

  test("success completion waits for the strict catalog barrier", async () => {
    const installed = deferred<void>()
    let barrierEntered = false
    const h = harness(
      [accountRow()],
      {},
      {
        refreshCatalogAfterMutation: async () => {
          barrierEntered = true
          await installed.promise
        },
      },
    )
    let finished = false
    const flight = h.refresher.refreshNow("acct-1").then((result) => {
      finished = true
      return result
    })
    await until(() => barrierEntered)
    expect(finished).toBe(false)
    expect(readStoredOAuth(CIPHER.decrypt(h.rows[0]?.authMaterial as string))?.refreshToken).toBe(
      "rt-2",
    )
    installed.resolve()
    expect((await flight).kind).toBe("success")
  })

  test("shutdown after parsed rotation waits for one durable CAS", async () => {
    const rows = [accountRow()]
    const repo = fakeAccounts(rows)
    const parsed = deferred<void>()
    const permit = deferred<void>()
    const h = harness(
      rows,
      {},
      {
        accounts: {
          ...repo,
          saveRefreshedCredential: async (input) => {
            parsed.resolve()
            await permit.promise
            return repo.saveRefreshedCredential(input)
          },
        },
      },
    )
    const flight = h.refresher.refreshNow("acct-1")
    await parsed.promise
    const stop = h.refresher.stop()
    permit.resolve()
    expect((await flight).kind).toBe("success")
    await stop
    expect(readStoredOAuth(CIPHER.decrypt(rows[0]?.authMaterial as string))?.refreshToken).toBe(
      "rt-2",
    )
    expect(h.schedule.count()).toBe(0)
  })

  test("shutdown during transport is neutral even if fetch ignores cancellation", async () => {
    const h = harness([accountRow()])
    const issuer = h.upstream.pause()
    const flight = h.refresher.refreshNow("acct-1")
    await until(() => h.upstream.calls() === 1)
    await h.refresher.stop()
    expect(await flight).toMatchObject({ kind: "skipped", reason: "aborted" })
    issuer.resolve(tokenResponse({ access_token: "too-late", refresh_token: "too-late" }))
    expect(h.events).toEqual([])
    expect(h.rows[0]?.status).toBe("active")
  })
  test("response-body timeout is bounded and cancels its reader", async () => {
    let cancelled = false
    const h = harness(
      [accountRow()],
      { timeoutMs: 10 },
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"access_token":'))
              },
              cancel() {
                cancelled = true
              },
            }),
          ),
      },
    )
    expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
      kind: "failure",
      reason: "unreachable",
    })
    expect(cancelled).toBe(true)
    expect(h.rows[0]?.status).toBe("active")
    await h.refresher.stop()
  })

  test("lock loss cancels stalled exchange neutrally and never retries within the section", async () => {
    const lost = new AbortController()
    const h = harness(
      [accountRow()],
      {},
      {
        refreshLock: {
          tryRun: async (_id, signal, work) => ({
            acquired: true,
            value: await work(AbortSignal.any([signal, lost.signal])),
          }),
        },
      },
    )
    const issuer = h.upstream.pause()
    const flight = h.refresher.refreshNow("acct-1")
    await until(() => h.upstream.calls() === 1)
    lost.abort()
    expect(await flight).toMatchObject({ kind: "skipped", reason: "aborted" })
    expect(h.upstream.calls()).toBe(1)
    expect(h.events).toEqual([])
    expect(h.schedule.delays()).toEqual([1_000])
    issuer.resolve(tokenResponse({ access_token: "ambiguous-late" }))
    await h.refresher.stop()
  })
})
