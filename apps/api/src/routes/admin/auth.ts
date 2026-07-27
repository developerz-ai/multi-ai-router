import { type Context, Hono } from "hono"
import { getConnInfo } from "hono/bun"
import { deleteCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import { renderErrorBody } from "../../errors/render"
import { type AdminAuthEnv, adminAuth } from "../../middleware/adminAuth"
import {
  ADMIN_API_TOKEN_ACTOR,
  type AdminAuthService,
  type AdminSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  sessionCookieWouldBeDiscarded,
  sessionExpiryMs,
} from "../../services/admin-auth"

/**
 * The admin plane's authentication routes — mountable on its own, because `app.ts` owns the
 * wiring. Thin, as CLAUDE.md requires: parse → validate with Zod → one service call → render.
 * Every rule (argon2id, throttling, session lifetime, CSRF) lives in `services/admin-auth/`.
 *
 * `POST /login`   — public, throttled per username and per IP. Sets the session cookie.
 * `POST /logout`  — guarded, and mutating, so it carries a CSRF token like any other mutation.
 * `GET  /session` — guarded. Who am I, and is this cookie still worth anything.
 */

/** Where these routes belong, per docs/idea/04-api-keys-and-access.md#admin-api-route-groups. */
export const ADMIN_AUTH_BASE_PATH = "/api/admin/auth"

export interface AdminAuthRoutesDeps {
  readonly service: AdminAuthService
  /** `Env.trustProxy`. Off by default: an unvetted `X-Forwarded-For` is a throttle bypass. */
  readonly trustProxy: boolean
  /**
   * `Env.adminAuth.sessionCookieInsecure` — drops `Secure` and `__Host-` so a plain-HTTP LAN
   * install can hold a session at all (`services/admin-auth/cookies.ts`). The guard below is
   * built from the same value: a writer and reader that disagree on the prefix produce a login
   * that answers `200` and a session nothing ever sees again.
   */
  readonly sessionCookieInsecure: boolean
  /**
   * `Env.adminApiToken`, handed to the guard this factory builds so `/session` answers a
   * token-authenticated caller too — which is how a script checks its credential is live without
   * mutating anything. Null leaves the plane browser-only.
   */
  readonly apiToken?: string | null
}

const loginSchema = z.object({
  // Bounded on both sides: argon2id over an unbounded password is a denial-of-service vector,
  // and the length limit is never a hint about the configured credential.
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
})

export function adminAuthRoutes(deps: AdminAuthRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  const guard = adminAuth(deps.service, deps.sessionCookieInsecure, deps.apiToken ?? null)

  routes.post("/login", async (c) => {
    const body = await readJson(c.req.raw)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        renderErrorBody(null, 400, "A username and a password are required", "invalid_request"),
        400,
      )
    }

    const result = await deps.service.login({
      username: parsed.data.username,
      password: parsed.data.password,
      ip: clientIp(c, deps.trustProxy),
    })

    setCookie(
      c,
      SESSION_COOKIE_NAME,
      result.cookieValue,
      sessionCookieOptions(result.cookieMaxAgeSeconds, deps.sessionCookieInsecure),
    )
    warnIfCookieUndeliverable(c, deps.sessionCookieInsecure)
    return c.json(sessionBody(result.session))
  })

  routes.post("/logout", guard, async (c) => {
    const session = c.get("adminSession")
    // A static token is not a session and cannot be ended by a request. Saying so is the point:
    // answering `logged_out` would report a revocation that did not happen, and the caller would
    // go on holding a credential it believes it just surrendered. Revoking this one means changing
    // the variable and restarting.
    if (session.username === ADMIN_API_TOKEN_ACTOR) {
      return c.json(
        renderErrorBody(
          null,
          400,
          "ADMIN_API_TOKEN is a static credential, not a session — it is revoked by changing the variable and restarting the router",
          "invalid_request",
        ),
        400,
      )
    }

    // The source address rides along for the same reason login's does: the audit row for a
    // session ending is only useful next to the one that started it.
    await deps.service.logout(session.id, clientIp(c, deps.trustProxy))
    deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(0, deps.sessionCookieInsecure))
    return c.json({ status: "logged_out" })
  })

  routes.get("/session", guard, (c) => c.json(sessionBody(c.get("adminSession"))))

  return routes
}

/**
 * The one misconfiguration this plane cannot answer with a status code. The login is a real `200`
 * and the browser discards the `Secure` cookie it carried, so the `401` lands on the *next*
 * request — see `services/admin-auth/cookies.ts`. The rule itself is pure and lives there; this is
 * only the log line, and it names the variable that fixes it rather than describing the symptom.
 *
 * Deliberately not in the response body: it is a deployment fact about this router, and the wire
 * shape of `/login` is a contract with the console (04-api-keys-and-access.md#session-cookie).
 */
function warnIfCookieUndeliverable(c: Context<AdminAuthEnv>, insecure: boolean): void {
  const undeliverable = sessionCookieWouldBeDiscarded({
    insecure,
    requestUrl: c.req.url,
    forwardedProto: c.req.header("x-forwarded-proto"),
  })
  if (!undeliverable) return

  c.get("log").warn(
    "login succeeded but the session cookie is Secure and this request arrived over plain HTTP — the browser will discard it and every request after it will be 401",
    {
      component: "admin-auth",
      remedy:
        "set SESSION_COOKIE_INSECURE=true for a plain-HTTP install, or terminate HTTPS in front and forward X-Forwarded-Proto",
    },
  )
}

/**
 * The SPA reads `csrfToken` from here and echoes it on every mutation. It is safe in a response
 * body and unsafe in a readable cookie for the same reason: the body is protected by the same
 * origin policy, a cookie is shared with every sibling host — see `services/admin-auth/csrf.ts`.
 */
function sessionBody(session: AdminSession): Record<string, string | null> {
  const expiry = sessionExpiryMs(session)
  return {
    username: session.username,
    csrfToken: session.csrfToken,
    issuedAt: new Date(session.createdAtMs).toISOString(),
    // `null`, not an instant: a static `ADMIN_API_TOKEN` has no expiry at all, and its session
    // says so with an infinite bound (`admin-auth/apiToken.ts`). Rendering that through `Date`
    // would throw `RangeError`, turning `GET /session` — the call a script makes precisely to
    // check its credential — into a 500.
    expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
  }
}

/** A malformed body is a validation failure, never a 500. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

const UNKNOWN_IP = "unknown"

/**
 * The address the per-IP throttle counts against. `X-Forwarded-For` is honored only when
 * `TRUST_PROXY` says a proxy we control is in front (07-security.md#secrets-in-transit) —
 * otherwise any caller could mint a fresh throttle bucket per attempt by editing a header.
 */
function clientIp(c: Context<AdminAuthEnv>, trust: boolean): string {
  if (trust) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded !== undefined && forwarded.length > 0) return forwarded
  }
  try {
    return getConnInfo(c).remote.address ?? UNKNOWN_IP
  } catch {
    // No Bun server behind this request — an `app.request(...)` call in a test. Every such
    // caller shares one bucket, which is the conservative direction to be wrong in.
    return UNKNOWN_IP
  }
}
