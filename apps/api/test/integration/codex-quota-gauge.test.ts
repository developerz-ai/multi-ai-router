import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createAccountRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { OPENAI_AUTH_CLAIM } from "../../src/providers"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness } from "./harness"

/**
 * End-to-end Codex usage gauge: a real account, a real dispatcher, a real health store, a mocked
 * upstream. Nothing here reaches the network, but everything else is the production path —
 * `attempt.ts → driver.parseRateLimit → health.applyRateLimit → foldRateLimit` — so the windows
 * that arrive on the admin view come from the same place the operator reads them in production.
 *
 * The criterion #184 names is: a mocked Codex reply carrying the headers the operator's request
 * just produced must surface two quotaWindows on the account, and a 100% reading must not block
 * the next request (display-only, never a `quota-window-spent` block).
 */

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

const DATE = "Sat, 11 Oct 2026 12:00:00 GMT"
const futureReset = Math.floor(new Date("2026-10-11T17:00:00Z").getTime() / 1000)

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

function codexHeaders(percent: number, minutes: number, resetAt: number): Record<string, string> {
  return {
    date: DATE,
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

describe.skipIf(!process.env.DATABASE_URL)("Codex usage gauge — end to end", () => {
  test("two quotaWindows appear on the account after one mocked Codex reply", async () => {
    const acc = await newCodexAccount()
    const { app, health } = harness({
      accounts: [acc],
      responses: [
        () =>
          codexResponse(200, codexHeaders(12, 300, futureReset), {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
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
    const { app, health } = harness({
      accounts: [acc],
      responses: [
        () =>
          jsonResponse(200, {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
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
    const { app, upstream } = harness({
      accounts: [acc],
      responses: [
        () =>
          codexResponse(200, codexHeaders(5, 300, futureReset), {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
        () =>
          codexResponse(200, codexHeaders(5, 300, futureReset), {
            id: "msg_2",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
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
    const { app, health } = harness({
      accounts: [acc],
      responses: [
        () =>
          codexResponse(200, codexHeaders(100, 300, futureReset), {
            id: "msg_1",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
        () =>
          codexResponse(200, codexHeaders(100, 300, futureReset), {
            id: "msg_2",
            object: "chat.completion",
            model: "codex-1",
            choices: [],
          }),
      ],
    })
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
  })
})
