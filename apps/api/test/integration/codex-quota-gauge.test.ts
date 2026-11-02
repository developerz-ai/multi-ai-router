import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createAccountRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { OPENAI_AUTH_CLAIM } from "../../src/providers"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "../../src/routes/admin/accounts"
import {
  type AccountView,
  type ConnectService,
  createAccountsService,
  type DiscoverModelsService,
  type RecheckService,
  type TestNowService,
  withAvailability,
} from "../../src/services/accounts"
import { createAuditRecorder } from "../../src/services/admin"
import type { HealthStore, RoutingCatalog } from "../../src/services/dataplane"
import { createMemoryConfigDirs } from "../support/config-dirs"
import { account, jsonResponse, NOW, type TestClock } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness } from "./harness"

/**
 * End-to-end Codex usage gauge: a real account, a real dispatcher, a real health store, a mocked
 * upstream. Nothing here reaches the network, but everything else is the production path —
 * `attempt.ts → driver.parseRateLimit → health.applyRateLimit → foldRateLimit` — so the windows
 * that arrive on the admin view come from the same place the operator reads them in production.
 *
 * The admin half answers through the **production route** (`adminAccountRoutes`), and it reads
 * time from the **same controlled clock** the data plane runs on: the reply's `Date` header, the
 * reset the reply reports, the accounts service's `now` and the availability overlay's `now` are
 * one clock. This suite used to hard-code a reset date, which made its verdict a function of the
 * wall clock — once that date passed, `isWindowSpent` reported "not spent" for *every* window,
 * advisory or not, so `spent: false` could no longer tell the advisory marker from an expired
 * reset. The twin window below is what keeps the assertion honest: the same 100% reading without
 * the marker reads `spent: true`, beside the two advisory windows that read `spent: false`.
 *
 * The criterion #184 names is: a mocked Codex reply carrying the headers the operator's request
 * just produced must surface two quotaWindows on the account, and a 100% reading must not block
 * the next request (display-only, never a `quota-window-spent` block).
 */

/** How far ahead of the controlled clock a reported reset sits. Long enough that the window is
 *  never expired relative to the instant the admin plane reads, short enough to be a window. */
const RESET_AHEAD_MS = 2 * 60 * 60 * 1000

/** A JWT-shaped access token carrying the `chatgpt_account_id` claim, since the Codex driver
 *  reads it off the credential to send the required `chatgpt-account-id` header. */
function codexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(
    JSON.stringify({
      [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: accountId },
      chatgpt_account_id: accountId,
    }),
  ).toString("base64url")
  return `${header}.${body}.not-a-real-signature`
}

/** The full stored-OAuth envelope; the cipher wraps this JSON, and `readStoredOAuth` reads it
 *  back as `{kind:"oauth", accessToken, ...}`. A bare JWT (without the JSON wrapper) is read as
 *  an API key, which the Codex driver rejects with `upstream_auth_failed`. */
function codexOAuthCredentialJson(accountId: string): string {
  return JSON.stringify({
    accessToken: codexAccessToken(accountId),
    refreshToken: null,
    providerAccountId: accountId,
  })
}

let db: DatabaseHandle | undefined
const cleanupAccountIds: string[] = []

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  db = createDatabase({ url, maxConnections: 4 })
})

afterAll(async () => {
  if (!db) return
  if (cleanupAccountIds.length > 0) {
    const accounts = createAccountRepository(db.db)
    for (const id of cleanupAccountIds) await accounts.delete(id).catch(() => undefined)
  }
  await db.close()
})

async function newCodexAccount() {
  if (!db) throw new Error("DATABASE_URL is required for this integration suite")
  const accounts = createAccountRepository(db.db)
  // The Codex driver reads the `chatgpt_account_id` claim off the credential and sends it on
  // every request as `chatgpt-account-id`. The fixture uses a JWT-shaped access token inside the
  // standard OAuth envelope so the dispatcher reaches the mocked upstream instead of failing auth.
  const credentialJson = codexOAuthCredentialJson("acct-codex-fixture")
  const created = await accounts.create({
    label: `codex-gauge-${crypto.randomUUID().slice(0, 8)}`,
    provider: "openai-oauth",
    authMaterial: CRYPTOR.encrypt(credentialJson),
  })
  cleanupAccountIds.push(created.id)
  return account(created.id, {
    provider: "openai-oauth",
    apiKey: credentialJson,
    cipher: CRYPTOR,
  })
}

function codexResponse(status: number, headers: Record<string, string>, body?: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * The Codex reply's headers, read off the controlled clock.
 *
 * The `date` header is the reply's own timestamp — the instant the Codex parser stamps on the
 * window as `lastCheckedAt`, and the only source it has for one. The reported reset is derived
 * from that same clock, so the window is never expired relative to the instant the admin plane
 * reads it against. A reset pinned to a calendar date would have made this suite's verdict depend
 * on the wall clock, which is exactly the bug the twin window below now rules out.
 */
function codexHeaders(now: () => Date, percent: number, minutes: number): Record<string, string> {
  const observedAt = now()
  const resetAt = Math.floor((observedAt.getTime() + RESET_AHEAD_MS) / 1000)
  return {
    date: observedAt.toUTCString(),
    "x-codex-primary-used-percent": String(percent),
    "x-codex-primary-window-minutes": String(minutes),
    "x-codex-primary-reset-at": String(resetAt),
    "x-codex-secondary-used-percent": String(percent),
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(resetAt + 86_400),
  }
}

function codexRequestBody() {
  return JSON.stringify({
    model: "codex-1",
    max_tokens: 64,
    messages: [{ role: "user", content: "ping" }],
  })
}

/** A window's reported reset as an epoch instant, or null where it names none. */
function resetMs(resetsAt: string | null): number | null {
  return resetsAt === null ? null : new Date(resetsAt).getTime()
}

/** A no-op audit sink: GET /api/admin/accounts is a read; the admin plane never audits a read.
 *  The recorder is wired so the service signature is satisfied, nothing more. */
const noopAudit = createAuditRecorder({ append: async () => undefined })

/** A `Pick`-style stub for the keys repository: only `listKeysScopedToAccount` is read here. */
const noopKeys = {
  listKeysScopedToAccount: async () => [] as never[],
}

/** A stub session middleware so the admin guard lets the GET request through. It stamps the
 *  session off the controlled clock, like everything else this suite reads time from. */
function stubSession(clock: TestClock): MiddlewareHandler<AdminAuthEnv> {
  return async (c, next) => {
    const nowMs = clock.now().getTime()
    c.set("adminSession", {
      id: "session-1",
      username: "admin",
      csrfToken: "csrf",
      createdAtMs: nowMs,
      lastSeenAtMs: nowMs,
      idleExpiryMs: 60 * 60 * 1000,
      absoluteExpiryMs: 12 * 60 * 60 * 1000,
    })
    await next()
  }
}

/** The services a `GET /api/admin/accounts` never reaches. A call to one is a bug in the test, so
 *  each throws rather than answering something the suite would then have to ignore. */
function unreachableRecheck(): RecheckService {
  const refuse = async (): Promise<never> => {
    throw new Error("re-check is not exercised by this suite")
  }
  return { recheck: refuse, recheckAll: refuse }
}

function unreachableTestNow(): TestNowService {
  return {
    test: async () => {
      throw new Error("test-now is not exercised by this suite")
    },
    lastCheckedAt: () => null,
  }
}

function unreachableDiscoverModels(): DiscoverModelsService {
  return {
    discover: async () => {
      throw new Error("discover-models is not exercised by this suite")
    },
  }
}

function unreachableConnect(): ConnectService {
  const refuse = async (): Promise<never> => {
    throw new Error("connect is not exercised by this suite")
  }
  return {
    begin: refuse,
    complete: refuse,
    cancel: refuse,
    redeem: refuse,
    beginDevice: refuse,
    deviceStatus: refuse,
    closeAdmission: () => {
      throw new Error("connect is not exercised by this suite")
    },
    revoke: () => {
      throw new Error("connect is not exercised by this suite")
    },
    stop: refuse,
  }
}

/** The admin plane, wired the way `app.ts` wires it: the production route group, a stub session
 *  guard, and the real accounts service under the real availability overlay. Both read the same
 *  controlled clock the data plane runs on — the account service and the overlay get the same
 *  `now`, so the console can never disagree with the router about which instant it is reading. */
async function adminAppFor(catalog: RoutingCatalog, health: HealthStore, clock: TestClock) {
  if (!db) throw new Error("DATABASE_URL is required for this integration suite")
  const configDirs = createMemoryConfigDirs()
  const accountsRepo = createAccountRepository(db.db)
  const accountsService = createAccountsService({
    accounts: accountsRepo,
    keys: noopKeys,
    cipher: CRYPTOR,
    configDirs: configDirs.dirs,
    revokeDeletedAccount: async () => undefined,
    deletionCommitted: async () => undefined,
    cleanupDeletedAccount: async () => "not_applicable" as const,
    audit: noopAudit,
    now: clock.now,
  })
  const decorated = withAvailability(accountsService, { catalog, health, now: clock.now })
  const app = new Hono<AdminAuthEnv>()
  app.route(
    ADMIN_ACCOUNTS_BASE_PATH,
    adminAccountRoutes({
      guard: stubSession(clock),
      service: decorated,
      recheck: unreachableRecheck(),
      testNow: unreachableTestNow(),
      discoverModels: unreachableDiscoverModels(),
      connect: unreachableConnect(),
    }),
  )
  return app
}

describe.skipIf(!process.env.DATABASE_URL)("Codex usage gauge — end to end", () => {
  test("two quotaWindows appear on the account after one mocked Codex reply", async () => {
    const acc = await newCodexAccount()
    // The harness owns the clock the data plane runs on; the reply's headers read it once the
    // harness has handed it back. The factories run at request time, never at wiring time.
    let readNow: () => Date = () => NOW
    const { app, health, clock } = harness({
      accounts: [acc],
      responses: [
        () =>
          codexResponse(200, codexHeaders(readNow, 12, 300), {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
    readNow = clock.now
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: codexRequestBody(),
    })
    expect(res.status).toBe(200)

    // The admin view reads the in-memory snapshot that `withAvailability` overlays onto the catalog
    // — verifying the snapshot is verifying the source the admin endpoint renders.
    await new Promise((resolve) => setImmediate(resolve))
    const state = health.stateOf(acc.id)
    expect(state.quotaWindows).toHaveLength(2)
    const fiveHour = state.quotaWindows.find((w) => w.window === "five_hour")
    const sevenDay = state.quotaWindows.find((w) => w.window === "seven_day")
    expect(fiveHour?.utilization).toBeCloseTo(0.12)
    expect(fiveHour?.advisory).toBe(true)
    expect(sevenDay?.utilization).toBeCloseTo(0.12)
    expect(sevenDay?.advisory).toBe(true)
  })

  test("no x-codex headers on the reply yields no quotaWindows on the account", async () => {
    const acc = await newCodexAccount()
    let readNow: () => Date = () => NOW
    const { app, health, clock } = harness({
      accounts: [acc],
      responses: [
        () =>
          // A `date` header is required so the test exercises the absent-x-codex-headers path,
          // not the no-Date path. `parseCodexQuotaHeaders` short-circuits on a missing Date
          // before it ever looks at the x-codex-* headers — without `date`, this test would
          // pass against a parser that was broken on every path, not just the one being guarded.
          jsonResponse(
            200,
            {
              id: "msg_1",
              object: "chat.completion",
              model: "codex-1",
              choices: [],
            },
            { date: readNow().toUTCString() },
          ),
      ],
    })
    readNow = clock.now
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: codexRequestBody(),
    })
    expect(res.status).toBe(200)

    await new Promise((resolve) => setImmediate(resolve))
    expect(health.stateOf(acc.id).quotaWindows).toHaveLength(0)
  })

  test("below-threshold utilization: the next request still routes and answers 200", async () => {
    const acc = await newCodexAccount()
    let readNow: () => Date = () => NOW
    const { app, upstream, clock } = harness({
      accounts: [acc],
      responses: [
        () =>
          codexResponse(200, codexHeaders(readNow, 5, 300), {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
        () =>
          codexResponse(200, codexHeaders(readNow, 5, 300), {
            id: "msg_2",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
    readNow = clock.now
    const first = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: codexRequestBody(),
    })
    expect(first.status).toBe(200)
    const second = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: codexRequestBody(),
    })
    expect(second.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
  })

  test("both windows at 100% with a future reset: the next request still routes and answers 200", async () => {
    const acc = await newCodexAccount()
    let readNow: () => Date = () => NOW
    const { app, health, catalog, clock } = harness({
      accounts: [acc],
      responses: [
        () =>
          codexResponse(200, codexHeaders(readNow, 100, 300), {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
        () =>
          codexResponse(200, codexHeaders(readNow, 100, 300), {
            id: "msg_2",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
    readNow = clock.now
    const first = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: codexRequestBody(),
    })
    expect(first.status).toBe(200)
    const second = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: codexRequestBody(),
    })
    expect(second.status).toBe(200)

    await new Promise((resolve) => setImmediate(resolve))
    const state = health.stateOf(acc.id)
    expect(state.quotaWindows).toHaveLength(2)
    for (const window of state.quotaWindows) {
      // utilization 1 is the at-capacity reading; advisory means the admin view's
      // `spent` flag is `false` regardless.
      expect(window.utilization).toBe(1)
      expect(window.advisory).toBe(true)
    }

    // The admin endpoint is what an operator actually reads — verify it carries the same
    // shape. Two `quotaWindows` with utilization 1 (the at-capacity reading) and `spent: false`
    // (the `advisory` flag's whole purpose: a 100% reading cannot take a single-member pool
    // out of rotation on the router's own say-so).
    const adminApp = await adminAppFor(catalog, health, clock)
    const listed = await adminApp.request("/api/admin/accounts")
    expect(listed.status).toBe(200)
    const accounts = (await listed.json()) as readonly AccountView[]
    const accountView = accounts.find((entry) => entry.id === acc.id)
    expect(accountView).toBeDefined()
    const windows = accountView?.availability?.quotaWindows ?? []
    expect(windows).toHaveLength(2)
    for (const window of windows) {
      expect(window.utilization).toBe(1)
      expect(window.spent).toBe(false)
      // The reset is still ahead of the clock the admin plane reads, so `spent: false` is the
      // advisory marker's verdict and not an expired window's. Without this, the assertion above
      // would hold for a second, unrelated reason the moment a reset date went by.
      const resetsAt = resetMs(window.resetsAt)
      expect(resetsAt).not.toBeNull()
      expect(resetsAt ?? 0).toBeGreaterThan(clock.now().getTime())
    }

    // The twin: the same 100% reading, with the same reset still ahead of the clock, but without
    // the advisory marker and on a kind the Codex reply never names — so the merge keeps it
    // standing beside the two advisory windows. It is injected through the health store, the only
    // channel a quota window travels, and only now: a spent non-advisory window is exactly what
    // takes an account out of rotation, so it must not exist while the routing assertions above
    // are running. Its verdict is the point of the whole exercise — `spent: true` beside two
    // `spent: false` readings is what makes those two mean "advisory" and not "expired".
    health.applyRateLimit(
      acc.id,
      {
        limited: false,
        resetSource: "provider-reported",
        windows: [],
        quotaWindows: [
          {
            window: "seven_day_opus",
            utilization: 1,
            utilizationSource: "continuous",
            resetsAt: new Date(clock.now().getTime() + RESET_AHEAD_MS),
            resetSource: "provider-reported",
            lastCheckedAt: clock.now(),
          },
        ],
      },
      clock.now(),
    )

    const relisted = await adminApp.request("/api/admin/accounts")
    expect(relisted.status).toBe(200)
    const after = (await relisted.json()) as readonly AccountView[]
    const afterView = after.find((entry) => entry.id === acc.id)
    const afterWindows = afterView?.availability?.quotaWindows ?? []
    expect(afterWindows).toHaveLength(3)
    const twin = afterWindows.find((window) => window.window === "seven_day_opus")
    expect(twin?.utilization).toBe(1)
    expect(twin?.spent).toBe(true)
    for (const window of afterWindows.filter((entry) => entry.window !== "seven_day_opus")) {
      expect(window.utilization).toBe(1)
      expect(window.spent).toBe(false)
    }
  })
})
