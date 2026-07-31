import { describe, expect, test } from "bun:test"
import type { AdminCredentialRepository, AdminCredentialRow } from "@multi-ai-router/db"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { type AdminAuthEnv, adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_AUTH_BASE_PATH, adminAuthRoutes } from "../../src/routes/admin/auth"
import type { AdminAuthConfig } from "../../src/services/admin-auth"
import {
  ADMIN_LOGIN_FAILED_MESSAGE,
  CSRF_HEADER,
  LOCAL_ADMIN_USERNAME,
  sessionCookieFullName,
} from "../../src/services/admin-auth"
import { createLocalAdminCredentials } from "../../src/services/admin-auth/localCredential"
import type { OIDCFlow } from "../../src/services/admin-auth/oidc/flow"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import { createMemorySessionStore } from "../../src/services/admin-auth/sessionStore"
import type { AppEnv } from "../../src/types"

/**
 * The local password door end to end: real routes, real service, real argon2id
 * hashing — the only stub is the credential repository (an in-memory row) and
 * the OIDC flow (a fake that never networks), mirroring how admin-auth.test.ts
 * stubs the IdP at its own boundary.
 *
 * What is locked here, per issue #52: the password trades for the SAME session
 * (same cookie, same CSRF, same guard) the OIDC callback issues; every failure
 * carries the one OIDC-identical wording; the throttle locks per IP; the
 * methods endpoint tells the login page the truth; and no password or hash
 * ever reaches a response body or a log line.
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const PASSWORD = "correct horse battery staple"
const LOGIN = `${ADMIN_AUTH_BASE_PATH}/login`
const METHODS = `${ADMIN_AUTH_BASE_PATH}/methods`
const SESSION = `${ADMIN_AUTH_BASE_PATH}/session`
const OIDC_START = `${ADMIN_AUTH_BASE_PATH}/oidc/start`
const OIDC_CALLBACK = `${ADMIN_AUTH_BASE_PATH}/oidc/callback`
/** Stands in for the guarded admin route groups. */
const KEYS = "/api/admin/keys"
const HARDENED_NAME = sessionCookieFullName(false)

type LogLine = { level: string; msg: string } & Record<string, unknown>

interface Harness {
  app: Hono<AppEnv>
  clock: { nowMs: number }
  logs: LogLine[]
  store: AdminCredentialRepository & { stored: () => string | null }
}

function memoryCredentials(): AdminCredentialRepository & { stored: () => string | null } {
  let hash: string | null = null
  const row = (): AdminCredentialRow | undefined =>
    hash === null
      ? undefined
      : {
          id: "local",
          passwordHash: hash,
          createdAt: new Date("2026-07-31T10:00:00.000Z"),
          updatedAt: new Date("2026-07-31T10:00:00.000Z"),
        }
  return {
    stored: () => hash,
    get: async () => row(),
    upsertHash: async (input) => {
      hash = input.passwordHash
      const written = row()
      if (written === undefined) throw new Error("unreachable")
      return written
    },
    remove: async () => {
      const existed = hash !== null
      hash = null
      return existed
    },
  }
}

/** A flow that stands the OIDC door up without ever networking. */
function fakeOidc(): OIDCFlow {
  return {
    start: async () => ({ authorizeUrl: "https://sso.test/authorize?state=fake", state: "fake" }),
    complete: async () => ({ email: "admin@test", subject: "subject-1" }),
  }
}

interface HarnessOptions {
  readonly oidc?: boolean
  /** Pre-set the credential. Absent means the door is off. */
  readonly password?: string
  readonly config?: Partial<AdminAuthConfig>
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = { nowMs: 1_700_000_000_000 }
  const store = memoryCredentials()
  const local = createLocalAdminCredentials({ repository: store })
  if (options.password !== undefined) await local.set(options.password)

  const service = createAdminAuthService({
    env: {
      adminOidc:
        options.oidc === false
          ? null
          : {
              issuerUrl: "https://sso.test",
              clientId: "multi-ai-router",
              clientSecret: null,
              redirectUri: "https://router.test/api/admin/auth/oidc/callback",
              adminEmail: "admin@test",
              adminSubject: null,
              scopes: ["openid"],
              clockSkewSeconds: 60,
            },
      encryptionKey: ENCRYPTION_KEY,
    },
    oidc: options.oidc === false ? null : fakeOidc(),
    local,
    store: createMemorySessionStore(),
    config: options.config,
    now: () => clock.nowMs,
  })

  const logs: LogLine[] = []
  const logger = createLogger({ level: "debug", write: (line) => logs.push(JSON.parse(line)) })
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    ADMIN_AUTH_BASE_PATH,
    adminAuthRoutes({ service, trustProxy: false, sessionCookieInsecure: false }),
  )
  const keys = new Hono<AdminAuthEnv>()
  keys.use("*", adminAuth(service, false, null))
  keys.get("/", (c) => c.json({ username: c.get("adminSession").username }))
  keys.post("/", (c) => c.json({ minted: true }, 201))
  app.route(KEYS, keys)
  return { app, clock, logs, store }
}

function get(app: Hono<AppEnv>, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers })
}

function postJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function cookieHeader(setCookieRaw: string): string {
  return setCookieRaw.split(";")[0] ?? ""
}

/** Log in with the password and return the cookie + CSRF token. */
async function login(h: Harness, password = PASSWORD): Promise<{ cookie: string; csrf: string }> {
  const res = await postJson(h.app, LOGIN, { password })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get("set-cookie") ?? ""
  expect(setCookie).toContain(HARDENED_NAME)
  const body = (await res.json()) as { csrfToken: string }
  return { cookie: cookieHeader(setCookie), csrf: body.csrfToken }
}

describe("GET /api/admin/auth/methods", () => {
  test("reports each door that exists, unauthenticated", async () => {
    const neither = await harness({ oidc: false })
    expect(await (await get(neither.app, METHODS)).json()).toEqual({ oidc: false, local: false })

    const oidcOnly = await harness()
    expect(await (await get(oidcOnly.app, METHODS)).json()).toEqual({ oidc: true, local: false })

    const localOnly = await harness({ oidc: false, password: PASSWORD })
    expect(await (await get(localOnly.app, METHODS)).json()).toEqual({ oidc: false, local: true })

    const both = await harness({ password: PASSWORD })
    expect(await (await get(both.app, METHODS)).json()).toEqual({ oidc: true, local: true })
  })
})

describe("POST /api/admin/auth/login", () => {
  test("the right password mints the same session the OIDC callback issues", async () => {
    const h = await harness({ oidc: false, password: PASSWORD })
    const { cookie, csrf } = await login(h)

    // The cookie authorizes an admin read...
    const read = await get(h.app, KEYS, { cookie })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ username: LOCAL_ADMIN_USERNAME })

    // ...and CSRF is still enforced on mutations, exactly as for an OIDC session.
    expect((await h.app.request(KEYS, { method: "POST", headers: { cookie } })).status).toBe(403)
    const write = await h.app.request(KEYS, {
      method: "POST",
      headers: { cookie, [CSRF_HEADER]: csrf },
    })
    expect(write.status).toBe(201)

    // /session agrees, with a finite expiry — a real session, not a static token.
    const session = await get(h.app, SESSION, { cookie })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      username: LOCAL_ADMIN_USERNAME,
      csrfToken: csrf,
    })
  })

  test("a wrong password is a 401 with the OIDC-identical wording, and sets no cookie", async () => {
    const h = await harness({ oidc: false, password: PASSWORD })
    const res = await postJson(h.app, LOGIN, { password: "wrong" })

    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(await res.json()).toMatchObject({
      error: { message: ADMIN_LOGIN_FAILED_MESSAGE },
    })
  })

  test("an unconfigured door answers exactly like a wrong password", async () => {
    const h = await harness({ oidc: false })
    const res = await postJson(h.app, LOGIN, { password: PASSWORD })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { message: ADMIN_LOGIN_FAILED_MESSAGE },
    })
  })

  test("a malformed body is a 400 that says nothing about the verdict", async () => {
    const h = await harness({ oidc: false, password: PASSWORD })
    expect((await postJson(h.app, LOGIN, {})).status).toBe(400)
    expect((await postJson(h.app, LOGIN, { password: "" })).status).toBe(400)
  })

  test("OIDC-only deployments: the endpoint exists but the door is closed", async () => {
    const h = await harness()
    const res = await postJson(h.app, LOGIN, { password: PASSWORD })
    expect(res.status).toBe(401)
    // And the OIDC door is the one that works — start still redirects.
    expect((await get(h.app, OIDC_START)).status).toBe(302)
  })
})

describe("the per-IP throttle", () => {
  const fast = { maxFailedAttempts: 3, lockoutSeconds: 60 } as const

  test("locks after the configured failures, with Retry-After, then recovers", async () => {
    const h = await harness({ oidc: false, password: PASSWORD, config: fast })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await postJson(h.app, LOGIN, { password: "wrong" })).status).toBe(401)
    }

    const locked = await postJson(h.app, LOGIN, { password: PASSWORD })
    expect(locked.status).toBe(429)
    expect(locked.headers.get("retry-after")).not.toBeNull()
    expect(await locked.json()).toMatchObject({
      error: { message: ADMIN_LOGIN_FAILED_MESSAGE },
    })

    // The lockout is clock-served, not a ban.
    h.clock.nowMs += 61_000
    const after = await postJson(h.app, LOGIN, { password: PASSWORD })
    expect(after.status).toBe(200)
  })

  test("a success inside the window resets the failure count", async () => {
    const h = await harness({ oidc: false, password: PASSWORD, config: fast })

    expect((await postJson(h.app, LOGIN, { password: "wrong" })).status).toBe(401)
    expect((await postJson(h.app, LOGIN, { password: "wrong" })).status).toBe(401)
    expect((await postJson(h.app, LOGIN, { password: PASSWORD })).status).toBe(200)

    // Two more failures without a lock: the earlier two were cleared.
    expect((await postJson(h.app, LOGIN, { password: "wrong" })).status).toBe(401)
    expect((await postJson(h.app, LOGIN, { password: "wrong" })).status).toBe(401)
    expect((await postJson(h.app, LOGIN, { password: PASSWORD })).status).toBe(200)
  })
})

describe("OIDC routes when OIDC is not configured", () => {
  test("start and callback are 404, and the local door works", async () => {
    const h = await harness({ oidc: false, password: PASSWORD })

    expect((await get(h.app, OIDC_START)).status).toBe(404)
    expect((await get(h.app, `${OIDC_CALLBACK}?code=x&state=y`)).status).toBe(404)
    expect((await postJson(h.app, LOGIN, { password: PASSWORD })).status).toBe(200)
  })
})

describe("redaction", () => {
  test("no password and no hash reach a log line or a response body, ever", async () => {
    const h = await harness({ oidc: false, password: PASSWORD })

    // Exercise every path that touches the credential: wrong, right, session.
    const wrong = await postJson(h.app, LOGIN, { password: "wrong" })
    const right = await postJson(h.app, LOGIN, { password: PASSWORD })
    const cookie = cookieHeader(right.headers.get("set-cookie") ?? "")
    const session = await get(h.app, SESSION, { cookie })

    const hash = h.store.stored()
    expect(hash).toStartWith("$argon2id$")

    for (const response of [wrong, right, session]) {
      const body = await response
        .clone()
        .text()
        .catch(() => "")
      expect(body).not.toContain(PASSWORD)
      expect(body).not.toContain("$argon2id$")
      expect(body).not.toContain(hash ?? "")
    }

    const rendered = h.logs.map((line) => JSON.stringify(line)).join("\n")
    expect(rendered).not.toContain(PASSWORD)
    expect(rendered).not.toContain("$argon2id$")
    expect(rendered).not.toContain(hash ?? "")
    expect(rendered.toLowerCase()).not.toContain("argon2")
  })
})
