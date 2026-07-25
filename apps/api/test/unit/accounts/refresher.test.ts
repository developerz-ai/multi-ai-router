import { describe, expect, test } from "bun:test"
import type { AccountRepository, AccountRow, AccountStatus } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import {
  type CredentialRefresher,
  type CredentialRefresherDeps,
  createCredentialRefresher,
  writeStoredOAuth,
} from "../../../src/services/accounts"
import type { AuditEventInput, AuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"

/**
 * The refresher: one timer per account, armed at a fraction of the token's remaining lifetime,
 * single-flighted, and honest about giving up. See `src/services/accounts/refresh/refresher.ts`'s
 * doc block for why this is deliberately not a scheduled task.
 *
 * The clock and the timer seam are both injected, so every test below drives them by hand instead
 * of racing a real `setTimeout` — the same discipline `test/unit/scheduler/fixtures.ts` uses for
 * the scheduler runner. `fetch` is injected too: no test here reaches a real token endpoint.
 */

const NOW = new Date("2026-07-25T09:00:00.000Z")
const CIPHER = createCredentialCipher({ key: new Uint8Array(32).fill(3) })

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acct-1",
    label: "acct-1",
    provider: "openai-oauth",
    status: "active",
    authMaterial: CIPHER.encrypt(
      writeStoredOAuth({ accessToken: "old-access", refreshToken: "rt-1" }),
    ),
    configDir: null,
    tokenExpiresAt: new Date(NOW.getTime() + 3_600_000),
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** The slice of `AccountRepository` the refresher needs, hand-rolled: real semantics, no database. */
function fakeAccounts(
  rows: AccountRow[],
): Pick<AccountRepository, "list" | "findById" | "update" | "updateStatus"> {
  return {
    list: async () => [...rows],
    findById: async (id) => rows.find((row) => row.id === id),
    update: async (id, patch, now) => {
      const index = rows.findIndex((row) => row.id === id)
      if (index === -1) return undefined
      const current = rows[index]
      if (current === undefined) return undefined
      const next = { ...current, ...patch, updatedAt: now }
      rows[index] = next
      return next
    },
    updateStatus: async (id, status: AccountStatus, now) => {
      const index = rows.findIndex((row) => row.id === id)
      if (index === -1) return undefined
      const current = rows[index]
      if (current === undefined) return undefined
      const next = { ...current, status, updatedAt: now }
      rows[index] = next
      return next
    },
  }
}

function fakeAudit(): { audit: AuditRecorder; events: AuditEventInput[] } {
  const events: AuditEventInput[] = []
  return { audit: { record: async (event) => void events.push(event) }, events }
}

interface FakeSchedule {
  readonly schedule: (run: () => void, delayMs: number) => () => void
  readonly delays: () => number[]
  readonly count: () => number
  readonly fireAll: () => void
}

/** A driven timer seam: nothing fires until a test says so. */
function fakeSchedule(): FakeSchedule {
  let calls: { id: number; run: () => void; delayMs: number }[] = []
  let nextId = 0
  return {
    schedule: (run, delayMs) => {
      const id = nextId++
      calls.push({ id, run, delayMs })
      return () => {
        calls = calls.filter((call) => call.id !== id)
      }
    },
    delays: () => calls.map((call) => call.delayMs),
    count: () => calls.length,
    fireAll: () => {
      const due = calls
      calls = []
      for (const call of due) call.run()
    },
  }
}

interface FakeFetch {
  readonly fetch: (request: Request) => Promise<Response>
  readonly calls: () => number
  respondWith(behavior: () => Promise<Response>): void
  /** Blocks the next call on a promise whose resolver is bound before any fetch happens. */
  pause(): { resolve: (response: Response) => void }
}

function fakeFetch(): FakeFetch {
  let count = 0
  let behavior: () => Promise<Response> = async () =>
    tokenResponse({ access_token: "new-access", refresh_token: "rt-2", expires_in: 3_600 })
  return {
    fetch: async () => {
      count += 1
      return behavior()
    },
    calls: () => count,
    respondWith: (next) => {
      behavior = next
    },
    pause: () => {
      let resolve!: (response: Response) => void
      const pending = new Promise<Response>((r) => {
        resolve = r
      })
      behavior = () => pending
      return { resolve }
    },
  }
}

interface Harness {
  readonly refresher: CredentialRefresher
  readonly rows: AccountRow[]
  readonly schedule: FakeSchedule
  readonly upstream: FakeFetch
  readonly events: AuditEventInput[]
  readonly clock: { now: Date }
}

function harness(
  rows: AccountRow[],
  overrides: Partial<CredentialRefresherDeps["config"]> = {},
): Harness {
  const schedule = fakeSchedule()
  const upstream = fakeFetch()
  const clock = { now: NOW }
  const { audit, events } = fakeAudit()

  const deps: CredentialRefresherDeps = {
    accounts: fakeAccounts(rows),
    cipher: CIPHER,
    audit,
    fetch: upstream.fetch,
    now: () => clock.now,
    logger: createLogger({ level: "error", write: () => undefined }),
    config: {
      leadFraction: 0.75,
      minDelayMs: 1_000,
      maxAttempts: 2,
      timeoutMs: 5_000,
      ...overrides,
    },
    schedule: schedule.schedule,
  }

  return { refresher: createCredentialRefresher(deps), rows, schedule, upstream, events, clock }
}

describe("arming, driven by the clock", () => {
  test("arms at a fraction of the remaining lifetime, not a fixed lead", async () => {
    const row = accountRow({ tokenExpiresAt: new Date(NOW.getTime() + 100_000) })
    const h = harness([row], { leadFraction: 0.75, minDelayMs: 1_000 })

    await h.refresher.start()

    // remaining 100s * 0.75 lead = 75s, well above the 1s floor.
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
    expect(first.ok).toBe(true)
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
    expect(first).toEqual({ ok: false, reason: "unreachable" })
    // Still active: one transient failure is not enough to park the account.
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("active")

    const second = await h.refresher.refreshNow(row.id)
    expect(second).toEqual({ ok: false, reason: "unreachable" })
    // maxAttempts reached: the account is parked, and no exception ever propagated.
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

    expect(outcome).toEqual({ ok: false, reason: "refused" })
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("needs_reauth")
  })

  test("no refresh token at all is refused, not retried", async () => {
    const row = accountRow({ authMaterial: CIPHER.encrypt(writeStoredOAuth({ accessToken: "a" })) })
    const h = harness([row], { maxAttempts: 5 })

    const outcome = await h.refresher.refreshNow(row.id)

    expect(outcome).toEqual({ ok: false, reason: "no-refresh-token" })
    expect(h.upstream.calls()).toBe(0)
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("needs_reauth")
  })

  test("a disabled account is left alone: disabled is the operator's word", async () => {
    const row = accountRow({ status: "disabled" })
    const h = harness([row])

    const outcome = await h.refresher.refreshNow(row.id)

    expect(outcome).toEqual({ ok: false, reason: "not-refreshable" })
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("disabled")
  })

  test("a success after a parked failure revives the account", async () => {
    const row = accountRow({ status: "needs_reauth" })
    const h = harness([row])

    const outcome = await h.refresher.refreshNow(row.id)

    expect(outcome.ok).toBe(true)
    expect(h.rows.find((r) => r.id === row.id)?.status).toBe("active")
    expect(h.events.at(-1)).toMatchObject({ kind: "account.reauthorized" })
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
