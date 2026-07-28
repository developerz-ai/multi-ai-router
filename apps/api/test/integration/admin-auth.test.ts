import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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
  ADMIN_API_TOKEN_ACTOR,
  ADMIN_API_TOKEN_MIN_LENGTH,
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  sessionCookieFullName,
} from "../../src/services/admin-auth"
import { createOIDCFlow } from "../../src/services/admin-auth/oidc/flow"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import { createMemorySessionStore } from "../../src/services/admin-auth/sessionStore"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import type { AppEnv } from "../../src/types"
import { createMemoryStore } from "../support/memory-store"

/**
 * Drives the real routes and the real guard through `app.request(...)`. The
 * OIDC provider is stubbed by a `fetch` injection: the flow's
 * `discovery`, `JWKS`, and `token` calls all hit the same `fetch` the
 * test installs, so the full HTTP dance plays out in process.
 *
 * The `/oidc/callback` route is the only one that genuinely serves HTML,
 * which is also what the caller will see in production. The `get`/`post`
 * helpers wrap `app.request(...)` so the assertions stay small.
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const LOGOUT = `${ADMIN_AUTH_BASE_PATH}/logout`
const SESSION = `${ADMIN_AUTH_BASE_PATH}/session`
const START = `${ADMIN_AUTH_BASE_PATH}/oidc/start`
const CALLBACK = `${ADMIN_AUTH_BASE_PATH}/oidc/callback`
/** Stands in for the admin route groups that land later. Behind the same guard. */
const KEYS = "/api/admin/keys"
/** The default, hardened wire name. `__Host-mar_admin_session`. */
const HARDENED_NAME = sessionCookieFullName(false)

const ISSUER = "https://sso.test"
const CLIENT_ID = "multi-ai-router"
const ADMIN_EMAIL = "admin@test"

type KeyPair = { privateKey: CryptoKey; publicJwk: JsonWebKey }

async function newKeyPair(kid: string): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256" } }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)))
}

async function signId(payload: Record<string, unknown>, kp: KeyPair): Promise<string> {
  const header = b64urlJson({ alg: "RS256", kid: kp.publicJwk.kid, typ: "JWT" })
  const body = b64urlJson(payload)
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    kp.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  )
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`
}

function discoveryDoc(jwksUri: string): unknown {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth2/v2/authorize`,
    token_endpoint: `${ISSUER}/oauth2/v2/token`,
    jwks_uri: jwksUri,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "email"],
    id_token_signing_alg_values_supported: ["RS256"],
  }
}

interface Harness {
  app: Hono<AppEnv>
  clock: { nowMs: number }
  keyPair: KeyPair
  store: ReturnType<typeof createMemoryStore>
  fetch: typeof fetch
  override: {
    email: string | null
    sub: string | null
    verified: boolean | null
  }
}

async function harness(
  config: Partial<AdminAuthConfig> = {},
  sessionCookieInsecure = false,
  apiToken: string | null = null,
  overlaps: Partial<{ email: string | null; sub: string | null; verified: boolean | null }> = {},
): Promise<Harness> {
  const clock = { nowMs: 1_700_000_000_000 }
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const keyPair = await newKeyPair("kid-1")
  const override = {
    email: overlaps.email ?? null,
    sub: overlaps.sub ?? null,
    verified: overlaps.verified ?? null,
  }
  const fetchImpl: typeof fetch = async (url, init) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify(discoveryDoc(`${ISSUER}/oauth2/v2/keys`)), {
        status: 200,
      })
    }
    if (url === `${ISSUER}/oauth2/v2/keys`) {
      return new Response(JSON.stringify({ keys: [keyPair.publicJwk] }), { status: 200 })
    }
    if (url === `${ISSUER}/oauth2/v2/token`) {
      const rawBody = (init?.body as string) ?? ""
      const params = new URLSearchParams(rawBody)
      const code = params.get("code") ?? ""
      const codeVerifier = params.get("code_verifier") ?? ""
      const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
      const [state, challenge] = code.split(":", 2)
      if (state === undefined || challenge === undefined) {
        return new Response("invalid", { status: 400 })
      }
      if (challenge !== expectedChallenge) {
        return new Response("verifier", { status: 400 })
      }
      const row = store.rows.oauthStates.find((r) => r.state === state)
      if (row === undefined) {
        return new Response("no state", { status: 400 })
      }
      const nonce = cipher.decrypt(row.nonce ?? "")
      const iat = Math.floor(clock.nowMs / 1000)
      const exp = iat + 600
      const idToken = await signId(
        {
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: override.sub ?? "subject-1",
          iat,
          exp,
          email: override.email ?? ADMIN_EMAIL,
          email_verified: override.verified ?? true,
          nonce,
        },
        keyPair,
      )
      return new Response(JSON.stringify({ id_token: idToken }))
    }
    return new Response("not found", { status: 404 })
  }
  const oidc = createOIDCFlow({
    config: {
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shh",
      redirectUri: "https://router.test/api/admin/auth/oidc/callback",
      adminEmail: ADMIN_EMAIL,
      scopes: ["openid", "profile", "email"],
    },
    stateStore: {
      states: store.oauthStates,
      cipher,
      stateMinutes: 10,
      now: () => new Date(clock.nowMs),
    },
    fetch: fetchImpl,
    now: () => new Date(clock.nowMs),
  })
  const service = createAdminAuthService({
    env: {
      adminOidc: {
        issuerUrl: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: "shh",
        redirectUri: "https://router.test/api/admin/auth/oidc/callback",
        adminEmail: ADMIN_EMAIL,
        adminSubject: null,
        scopes: ["openid", "profile", "email"],
        clockSkewSeconds: 60,
      },
      encryptionKey: ENCRYPTION_KEY,
    },
    oidc,
    store: createMemorySessionStore(),
    config,
    now: () => clock.nowMs,
  })
  const logs: LogLine[] = []
  const logger = createLogger({
    level: "warn",
    write: (line) => logs.push(JSON.parse(line) as LogLine),
  })
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    ADMIN_AUTH_BASE_PATH,
    adminAuthRoutes({ service, trustProxy: false, sessionCookieInsecure, apiToken }),
  )
  const keys = new Hono<AdminAuthEnv>()
  keys.use("*", adminAuth(service, sessionCookieInsecure, apiToken))
  keys.get("/", (c) => c.json({ username: c.get("adminSession").username }))
  keys.post("/", (c) => c.json({ minted: true }, 201))
  app.route(KEYS, keys)
  return { app, clock, keyPair, store, fetch: fetchImpl, override }
}

type LogLine = { level: string; msg: string } & Record<string, unknown>
type App = Hono<AppEnv>

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { headers })
}

function post(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: "POST", headers })
}

function setCookieValue(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? ""
  const first = raw.split(";")[0] ?? ""
  return first.split("=")[1] ?? ""
}

/** Walk the OIDC dance end-to-end and return the cookie value. */
async function completeLogin(h: Harness): Promise<{ cookie: string; csrfToken: string }> {
  const startRes = await get(h.app, START)
  expect(startRes.status).toBe(302)
  const location = startRes.headers.get("location") ?? ""
  const url = new URL(location)
  const state = url.searchParams.get("state")
  expect(state).toBeTruthy()
  // The redirect URL has all the right params.
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  // Pull the challenge from the URL and mint the code. The flow's token
  // exchange will read the matching verifier from the row.
  const row = h.store.rows.oauthStates.find((r) => r.state === state)
  if (row === undefined) throw new Error("state row missing")
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const codeVerifier = cipher.decrypt(row.codeVerifier)
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const code = `${state}:${challenge}`
  const callbackRes = await get(
    h.app,
    `${CALLBACK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? "")}`,
  )
  expect(callbackRes.status).toBe(200)
  const setCookieRaw = callbackRes.headers.get("set-cookie") ?? ""
  const cookie = setCookieValue(callbackRes)
  expect(cookie.length).toBeGreaterThan(0)
  // The session is created and the SPI has a CSRF token we can read out.
  const session = await get(h.app, SESSION, { cookie: cookieHeader(setCookieRaw) })
  expect(session.status).toBe(200)
  const body = (await session.json()) as { csrfToken: string; username: string }
  expect(body.username).toBe(ADMIN_EMAIL)
  return { cookie: cookieHeader(setCookieRaw), csrfToken: body.csrfToken }
}

function cookieHeader(setCookieRaw: string): string {
  if (setCookieRaw.length === 0) return ""
  const first = setCookieRaw.split(";")[0] ?? ""
  return first
}

describe("GET /api/admin/auth/oidc/start", () => {
  test("issues a state row and redirects to the IdP's authorize endpoint", async () => {
    const h = await harness()
    const res = await get(h.app, START)
    expect(res.status).toBe(302)
    const location = res.headers.get("location") ?? ""
    const url = new URL(location)
    expect(url.origin).toBe(new URL(ISSUER).origin)
    expect(url.pathname).toBe("/oauth2/v2/authorize")
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    // The state is bound to a row in the store.
    const state = url.searchParams.get("state")
    expect(state).toBeTruthy()
    expect(h.store.rows.oauthStates.find((r) => r.state === state)).toBeDefined()
  })
})

describe("GET /api/admin/auth/oidc/callback", () => {
  test("the full HTTP dance: callback sets the session cookie and /session returns admin", async () => {
    const h = await harness()
    const { cookie } = await completeLogin(h)
    expect(cookie).toContain(HARDENED_NAME.split("=")[0])
  })

  test("a missing state or code is rejected", async () => {
    const h = await harness()
    const res = await get(h.app, CALLBACK)
    expect(res.status).toBe(400)
  })

  test("a code/state mismatch is rejected with the same wording as a state failure", async () => {
    const h = await harness()
    await get(h.app, START)
    const res = await get(h.app, `${CALLBACK}?code=does-not-matter&state=never-issued`)
    expect(res.status).toBe(401)
    expect((await res.text()).toLowerCase()).toContain("single sign-on")
  })

  test("a code that was already redeemed is rejected", async () => {
    const h = await harness()
    // Walk the first login through, capture the state and code.
    const startRes = await get(h.app, START)
    const firstUrl = new URL(startRes.headers.get("location") ?? "")
    const firstState = firstUrl.searchParams.get("state") ?? ""
    const firstRow = h.store.rows.oauthStates.find((r) => r.state === firstState)
    if (firstRow === undefined) throw new Error("state row missing")
    const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
    const firstCodeVerifier = cipher.decrypt(firstRow.codeVerifier)
    const firstChallenge = createHash("sha256").update(firstCodeVerifier).digest("base64url")
    const firstCode = `${firstState}:${firstChallenge}`
    const firstCallback = await get(
      h.app,
      `${CALLBACK}?code=${encodeURIComponent(firstCode)}&state=${encodeURIComponent(firstState)}`,
    )
    expect(firstCallback.status).toBe(200)
    // The state is now consumed. Replaying the same code is the second call.
    const replay = await get(
      h.app,
      `${CALLBACK}?code=${encodeURIComponent(firstCode)}&state=${encodeURIComponent(firstState)}`,
    )
    expect(replay.status).toBe(401)
  })

  test("an id_token whose email does not match the configured admin is rejected", async () => {
    const h = await harness({}, false, null, { email: "someone-else@test" })
    const startRes = await get(h.app, START)
    const url = new URL(startRes.headers.get("location") ?? "")
    const state = url.searchParams.get("state") ?? ""
    const row = h.store.rows.oauthStates.find((r) => r.state === state)
    if (row === undefined) throw new Error("state row missing")
    const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
    const codeVerifier = cipher.decrypt(row.codeVerifier)
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const code = `${state}:${challenge}`
    const res = await get(
      h.app,
      `${CALLBACK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    )
    expect(res.status).toBe(401)
  })
})

describe("GET /api/admin/auth/session", () => {
  test("a valid session reports who it belongs to", async () => {
    const h = await harness()
    const { cookie } = await completeLogin(h)
    const res = await get(h.app, SESSION, { cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      username: ADMIN_EMAIL,
      csrfToken: expect.any(String) as unknown,
    })
  })

  test("no cookie, a garbage cookie, and a forged one are all 401", async () => {
    const h = await harness()
    const garbled = Buffer.alloc(32, 3).toString("base64url")
    expect((await get(h.app, SESSION)).status).toBe(401)
    expect(
      (await get(h.app, SESSION, { cookie: `${SESSION_COOKIE_NAME}=${garbled}` })).status,
    ).toBe(401)
    expect((await get(h.app, SESSION, { cookie: `${HARDENED_NAME}=not-a-real-jws` })).status).toBe(
      401,
    )
  })

  test("an expired session does not pass the guard", async () => {
    const h = await harness({ idleTtlSeconds: 60 })
    const { cookie } = await completeLogin(h)
    h.clock.nowMs += 120_000
    const res = await get(h.app, SESSION, { cookie })
    expect(res.status).toBe(401)
  })
})

describe("CSRF", () => {
  test("a mutating admin request without a token is rejected", async () => {
    const h = await harness()
    const { cookie } = await completeLogin(h)
    const res = await post(h.app, KEYS, { cookie })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { message: "Missing or invalid CSRF token", code: "csrf_token_invalid" },
    })
  })

  test("another session's token does not work; the request's own does", async () => {
    const h = await harness()
    const { cookie, csrfToken } = await completeLogin(h)
    const other = await completeLogin(h)
    expect((await post(h.app, KEYS, { cookie, [CSRF_HEADER]: other.csrfToken })).status).toBe(403)
    expect((await post(h.app, KEYS, { cookie, [CSRF_HEADER]: csrfToken })).status).toBe(201)
    expect((await get(h.app, KEYS, { cookie })).status).toBe(200)
  })

  test("a token without a session is still 401 — CSRF is not authentication", async () => {
    const h = await harness()
    const { csrfToken } = await completeLogin(h)
    expect((await post(h.app, KEYS, { [CSRF_HEADER]: csrfToken })).status).toBe(401)
  })
})

describe("POST /api/admin/auth/logout", () => {
  test("clears the cookie and invalidates the session server-side", async () => {
    const h = await harness()
    const { cookie, csrfToken } = await completeLogin(h)
    const res = await post(h.app, LOGOUT, { cookie, [CSRF_HEADER]: csrfToken })
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0")
    expect((await get(h.app, SESSION, { cookie })).status).toBe(401)
  })

  test("is itself a mutation and needs a CSRF token", async () => {
    const h = await harness()
    const { cookie } = await completeLogin(h)
    expect((await post(h.app, LOGOUT, { cookie })).status).toBe(403)
    expect((await get(h.app, SESSION, { cookie })).status).toBe(200)
  })
})

describe("the two credential spaces never overlap", () => {
  const refused = {
    error: {
      message: "A router API key cannot authenticate the admin plane",
      code: "admin_auth_failed",
    },
  }
  test("a mar_live_ router key is refused on an admin route, in either header style", async () => {
    const h = await harness()
    const key = generateRouterKey()
    expect(key).toStartWith(ROUTER_KEY_PREFIX)
    for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
      const res = await get(h.app, KEYS, headers)
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject(refused)
    }
  })

  test("a router key does not become admin by riding alongside a valid session", async () => {
    const h = await harness()
    const { cookie, csrfToken } = await completeLogin(h)
    const key = generateRouterKey()
    expect((await get(h.app, KEYS, { cookie, authorization: `Bearer ${key}` })).status).toBe(401)
    const write = await post(h.app, KEYS, { cookie, [CSRF_HEADER]: csrfToken, "x-api-key": key })
    expect(write.status).toBe(401)
  })
})

describe("admin api token", () => {
  const TOKEN = "z".repeat(ADMIN_API_TOKEN_MIN_LENGTH)

  test("reads and writes with a bearer token, and needs no CSRF token to do it", async () => {
    const h = await harness({}, false, TOKEN)
    const headers = { authorization: `Bearer ${TOKEN}` }
    const read = await get(h.app, KEYS, headers)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ username: ADMIN_API_TOKEN_ACTOR })
    expect((await post(h.app, KEYS, headers)).status).toBe(201)
  })

  test("the plane is closed to it when no token is configured", async () => {
    const h = await harness()
    expect((await get(h.app, KEYS, { authorization: `Bearer ${TOKEN}` })).status).toBe(401)
  })

  test("a wrong token is a 401, not a fallback to some other credential", async () => {
    const h = await harness({}, false, TOKEN)
    expect((await get(h.app, KEYS, { authorization: `Bearer ${"y".repeat(48)}` })).status).toBe(401)
    expect((await get(h.app, KEYS, { authorization: "Bearer " })).status).toBe(401)
  })

  test("logout says a static token is not a session rather than reporting a revocation", async () => {
    const h = await harness({}, false, TOKEN)
    const res = await post(h.app, LOGOUT, { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(400)
    expect((await get(h.app, KEYS, { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
  })

  test("GET /session answers the token holder with a null expiry", async () => {
    const h = await harness({}, false, TOKEN)
    const res = await get(h.app, SESSION, { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      username: ADMIN_API_TOKEN_ACTOR,
      csrfToken: "",
      expiresAt: null,
    })
  })

  test("a cookie session still works alongside a token, and still needs its CSRF token", async () => {
    const h = await harness({}, false, TOKEN)
    const { cookie, csrfToken } = await completeLogin(h)
    expect((await get(h.app, KEYS, { cookie })).status).toBe(200)
    expect((await post(h.app, KEYS, { cookie })).status).toBe(403)
    expect((await post(h.app, KEYS, { cookie, [CSRF_HEADER]: csrfToken })).status).toBe(201)
  })

  test("an empty CSRF header cannot borrow the token session's empty token", async () => {
    const h = await harness({}, false, TOKEN)
    const { cookie } = await completeLogin(h)
    expect((await post(h.app, KEYS, { cookie, [CSRF_HEADER]: "" })).status).toBe(403)
  })
})
