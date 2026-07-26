import { describe, expect, test } from "bun:test"
import { generateRouterKey, ROUTER_KEY_PREFIX } from "@multi-ai-router/core"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { type AdminAuthEnv, adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_AUTH_BASE_PATH, adminAuthRoutes } from "../../src/routes/admin/auth"
import type { AdminAuthConfig } from "../../src/services/admin-auth"
import {
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  sessionCookieFullName,
} from "../../src/services/admin-auth"
import { ARGON2ID_PARAMS } from "../../src/services/admin-auth/password"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import type { AppEnv } from "../../src/types"

/**
 * Drives the real routes and the real guard through `app.request(...)`. `app.ts` is not ours to
 * wire, so the harness mounts the sub-router exactly the way `createApp` will — which also
 * proves it is mountable.
 */

const PASSWORD = "hunter2"
const PASSWORD_HASH = await Bun.password.hash(PASSWORD, ARGON2ID_PARAMS)
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const LOGIN = `${ADMIN_AUTH_BASE_PATH}/login`
const LOGOUT = `${ADMIN_AUTH_BASE_PATH}/logout`
const SESSION = `${ADMIN_AUTH_BASE_PATH}/session`
/** Stands in for the admin route groups that land later. Behind the same guard. */
const KEYS = "/api/admin/keys"
/** The default, hardened wire name. `__Host-mar_admin_session`. */
const HARDENED_NAME = sessionCookieFullName(false)

function harness(config: Partial<AdminAuthConfig> = {}, sessionCookieInsecure = false) {
  const clock = { nowMs: 1_700_000_000_000 }
  const service = createAdminAuthService({
    env: {
      adminUsername: "admin",
      adminCredential: { kind: "hash", value: PASSWORD_HASH },
      encryptionKey: ENCRYPTION_KEY,
    },
    config,
    now: () => clock.nowMs,
  })

  const logger = createLogger({ level: "error", write: () => undefined })
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    ADMIN_AUTH_BASE_PATH,
    adminAuthRoutes({ service, trustProxy: false, sessionCookieInsecure }),
  )

  const keys = new Hono<AdminAuthEnv>()
  keys.use("*", adminAuth(service, sessionCookieInsecure))
  keys.get("/", (c) => c.json({ username: c.get("adminSession").username }))
  keys.post("/", (c) => c.json({ minted: true }, 201))
  app.route(KEYS, keys)

  return { app, clock }
}

type App = ReturnType<typeof harness>["app"]

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { headers })
}

function post(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: "POST", headers })
}

function login(app: App, body: unknown): Promise<Response> {
  return app.request(LOGIN, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function setCookieValue(res: Response): string {
  const header = res.headers.get("set-cookie")
  expect(header).not.toBeNull()
  return header ?? ""
}

/** Logs in and returns the `Cookie:` header a browser would send back, plus the CSRF token. */
async function loggedIn(app: App): Promise<{ cookie: string; csrfToken: string }> {
  const res = await login(app, { username: "admin", password: PASSWORD })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { csrfToken: string }
  return { cookie: setCookieValue(res).split(";")[0] ?? "", csrfToken: body.csrfToken }
}

describe("POST /api/admin/auth/login", () => {
  test("the right credentials set the session cookie with every required flag", async () => {
    const { app } = harness()
    const res = await login(app, { username: "admin", password: PASSWORD })

    expect(res.status).toBe(200)
    const cookie = setCookieValue(res)
    expect(cookie).toStartWith(`${HARDENED_NAME}=`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=")

    const body = (await res.json()) as Record<string, string>
    expect(body).toMatchObject({ username: "admin" })
    expect(body.csrfToken).toBeString()
    expect(body.expiresAt).toBeString()
    // The response carries no credential material and never restates the cookie.
    expect(JSON.stringify(body)).not.toContain(PASSWORD)
    expect(JSON.stringify(body)).not.toContain(cookie.split("=")[1]?.split(";")[0] ?? "?")
  })

  test("a wrong password and an unknown username are byte-identical failures", async () => {
    const { app } = harness()

    const wrongPassword = await login(app, { username: "admin", password: "nope" })
    const unknownUser = await login(app, { username: "root", password: PASSWORD })

    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.status).toBe(401)
    expect(await unknownUser.text()).toBe(await wrongPassword.text())
    expect(wrongPassword.headers.get("set-cookie")).toBeNull()
  })

  test("the failure body names neither half of the credential", async () => {
    const { app } = harness()
    const res = await login(app, { username: "admin", password: "nope" })

    expect(await res.json()).toEqual({
      error: {
        message: "Invalid username or password",
        type: "authentication_error",
        param: null,
        code: "admin_auth_failed",
      },
    })
  })

  test("a malformed or incomplete body is a 400, not a 500", async () => {
    const { app } = harness()

    for (const body of [{}, { username: "admin" }, { username: "", password: "" }, "not json"]) {
      expect((await login(app, body)).status).toBe(400)
    }
  })

  test("throttling engages after the configured attempts and releases after the window", async () => {
    const { app, clock } = harness({ maxFailedAttempts: 3, lockoutSeconds: 900 })
    const good = { username: "admin", password: PASSWORD }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login(app, { username: "admin", password: "nope" })).status).toBe(401)
    }

    // Locked: even the correct password is refused, and the answer carries a Retry-After.
    const locked = await login(app, good)
    expect(locked.status).toBe(429)
    expect(locked.headers.get("Retry-After")).toBe("900")
    expect(locked.headers.get("set-cookie")).toBeNull()

    clock.nowMs += 899 * 1000
    expect((await login(app, good)).status).toBe(429)

    clock.nowMs += 1_000
    expect((await login(app, good)).status).toBe(200)
  })
})

describe("SESSION_COOKIE_INSECURE", () => {
  test("drops Secure and __Host- and keeps everything that does not need HTTPS", async () => {
    const { app } = harness({}, true)
    const res = await login(app, { username: "admin", password: PASSWORD })

    expect(res.status).toBe(200)
    const cookie = setCookieValue(res)
    expect(cookie).toStartWith(`${sessionCookieFullName(true)}=`)
    expect(cookie).not.toContain("__Host-")
    expect(cookie).not.toContain("Secure")
    // Everything that is not a property of the transport survives.
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=")
  })

  test("the guard reads the cookie back — which is the whole point of the flag", async () => {
    const { app } = harness({}, true)
    const { cookie, csrfToken } = await loggedIn(app)

    expect(cookie).toStartWith(`${SESSION_COOKIE_NAME}=`)
    expect((await get(app, SESSION, { cookie })).status).toBe(200)
    expect((await get(app, KEYS, { cookie })).status).toBe(200)
    // CSRF is unaffected: it never depended on the cookie's transport attributes.
    expect((await post(app, KEYS, { cookie })).status).toBe(403)
    expect((await post(app, KEYS, { cookie, [CSRF_HEADER]: csrfToken })).status).toBe(201)
  })

  test("logout still clears the cookie it actually set", async () => {
    const { app } = harness({}, true)
    const { cookie, csrfToken } = await loggedIn(app)

    const res = await post(app, LOGOUT, { cookie, [CSRF_HEADER]: csrfToken })

    expect(res.status).toBe(200)
    const cleared = setCookieValue(res)
    expect(cleared).toStartWith(`${SESSION_COOKIE_NAME}=`)
    expect(cleared).toContain("Max-Age=0")
    expect((await get(app, SESSION, { cookie })).status).toBe(401)
  })

  test("a hardened-mode cookie is not accepted by an insecure-mode guard, or the reverse", async () => {
    const hardened = await loggedIn(harness().app)
    const insecure = await loggedIn(harness({}, true).app)

    // The names differ, so neither name is even looked up by the other mode's guard. This is a
    // property worth pinning: flipping the flag invalidates live sessions rather than silently
    // downgrading them.
    expect(hardened.cookie).toStartWith(`${HARDENED_NAME}=`)
    expect(insecure.cookie).toStartWith(`${SESSION_COOKIE_NAME}=`)
    expect((await get(harness({}, true).app, SESSION, { cookie: hardened.cookie })).status).toBe(
      401,
    )
    expect((await get(harness().app, SESSION, { cookie: insecure.cookie })).status).toBe(401)
  })
})

describe("GET /api/admin/auth/session", () => {
  test("a valid session reports who it belongs to", async () => {
    const { app } = harness()
    const { cookie } = await loggedIn(app)

    const res = await get(app, SESSION, { cookie })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ username: "admin" })
  })

  test("no cookie, a garbage cookie, and a forged one are all 401", async () => {
    const { app } = harness()
    const { cookie } = await loggedIn(app)
    const forged = `${HARDENED_NAME}=${cookie.split("=")[1]?.slice(0, -2)}xx`

    for (const headers of [{}, { cookie: `${HARDENED_NAME}=garbage` }, { cookie: forged }]) {
      expect((await get(app, SESSION, headers)).status).toBe(401)
    }
  })

  test("an expired session does not pass the guard", async () => {
    const { app, clock } = harness({ idleTtlSeconds: 3600 })
    const { cookie } = await loggedIn(app)

    clock.nowMs += 3_599_000
    expect((await get(app, SESSION, { cookie })).status).toBe(200)

    clock.nowMs += 3_600_000
    const res = await get(app, SESSION, { cookie })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { message: "Admin session has expired", code: "admin_auth_failed" },
    })
  })
})

describe("CSRF", () => {
  test("a mutating admin request without a token is rejected", async () => {
    const { app } = harness()
    const { cookie } = await loggedIn(app)

    const res = await post(app, KEYS, { cookie })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { message: "Missing or invalid CSRF token", code: "csrf_token_invalid" },
    })
  })

  test("another session's token does not work; the request's own does", async () => {
    const { app } = harness()
    const { cookie, csrfToken } = await loggedIn(app)
    const other = await loggedIn(app)

    expect((await post(app, KEYS, { cookie, [CSRF_HEADER]: other.csrfToken })).status).toBe(403)
    expect((await post(app, KEYS, { cookie, [CSRF_HEADER]: csrfToken })).status).toBe(201)
    // A read needs no token — the cookie alone is enough.
    expect((await get(app, KEYS, { cookie })).status).toBe(200)
  })

  test("a token without a session is still 401 — CSRF is not authentication", async () => {
    const { app } = harness()
    const { csrfToken } = await loggedIn(app)

    expect((await post(app, KEYS, { [CSRF_HEADER]: csrfToken })).status).toBe(401)
  })
})

describe("POST /api/admin/auth/logout", () => {
  test("clears the cookie and invalidates the session server-side", async () => {
    const { app } = harness()
    const { cookie, csrfToken } = await loggedIn(app)

    const res = await post(app, LOGOUT, { cookie, [CSRF_HEADER]: csrfToken })

    expect(res.status).toBe(200)
    expect(setCookieValue(res)).toContain("Max-Age=0")
    // Replaying the cookie proves the invalidation is server-side, not a client instruction.
    expect((await get(app, SESSION, { cookie })).status).toBe(401)
  })

  test("is itself a mutation and needs a CSRF token", async () => {
    const { app } = harness()
    const { cookie } = await loggedIn(app)

    expect((await post(app, LOGOUT, { cookie })).status).toBe(403)
    // And the session survived the failed attempt.
    expect((await get(app, SESSION, { cookie })).status).toBe(200)
  })
})

describe("the two credential spaces never overlap", () => {
  // `admin_auth_failed`, never `key_revoked`: the code is what tells an operator which
  // credential space rejected them, and a console login is not an API key going bad.
  const refused = {
    error: {
      message: "A router API key cannot authenticate the admin plane",
      code: "admin_auth_failed",
    },
  }

  test("a mar_live_ router key is refused on an admin route, in either header style", async () => {
    const { app } = harness()
    const key = generateRouterKey()
    expect(key).toStartWith(ROUTER_KEY_PREFIX)

    for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
      const res = await get(app, KEYS, headers)

      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject(refused)
    }
  })

  test("a router key does not become admin by riding alongside a valid session", async () => {
    const { app } = harness()
    const { cookie, csrfToken } = await loggedIn(app)
    const key = generateRouterKey()

    expect((await get(app, KEYS, { cookie, authorization: `Bearer ${key}` })).status).toBe(401)
    const write = await post(app, KEYS, { cookie, [CSRF_HEADER]: csrfToken, "x-api-key": key })
    expect(write.status).toBe(401)
  })

  test("a malformed or padded router key gets the same answer as a well-formed one", async () => {
    const { app } = harness()

    for (const value of [`${ROUTER_KEY_PREFIX}short`, `  ${generateRouterKey()}`]) {
      const res = await get(app, KEYS, { "x-api-key": value })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject(refused)
    }
  })
})
