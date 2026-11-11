import { AdminAuthError } from "@multi-ai-router/core"
import { type Context, Hono } from "hono"
import { getConnInfo } from "hono/bun"
import { deleteCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import { REQUEST_WALL, refusalBody } from "../../errors/render"
import type { RouterVerdict } from "../../errors/router-object"
import { type AdminAuthEnv, adminAuth } from "../../middleware/adminAuth"
import { readJsonBody } from "../../services/admin"
import {
  ADMIN_API_TOKEN_ACTOR,
  ADMIN_LOGIN_FAILED_MESSAGE,
  type AdminAuthService,
  AdminLoginThrottledError,
  type AdminSession,
  clientIp as resolveClientIp,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  sessionCookieWouldBeDiscarded,
  sessionExpiryMs,
} from "../../services/admin-auth"
import { callbackPage, callbackPageSignedIn } from "./auth-callback-page"

/**
 * The admin plane's authentication routes — mountable on its own, because `app.ts` owns the
 * wiring. Thin, as CLAUDE.md requires: parse → validate with Zod → one service call → render.
 * Every rule (PKCE, JWKS verification, session lifetime, CSRF, the login throttle) lives in
 * `services/admin-auth/`.
 *
 * `GET /methods`      — public, unguarded. Which sign-in doors this deployment has, so the
 *                          login page knows what to render. Reveals nothing an unauthenticated
 *                          caller could not learn by trying both.
 * `POST /login`       — public, per-IP throttled. The local password door: trades the password
 *                          for the same session the OIDC callback issues. Every failure,
 *                          whatever its cause, carries the one OIDC-identical wording.
 * `GET /oidc/start`    — public. Mints the state and the nonce, returns a 302 to the IdP's
 *                          authorize endpoint. 404 when OIDC is not configured.
 * `GET /oidc/callback`  — public. The IdP sends the browser back with the `code` and `state`.
 *                          The route renders the HTML callback page. 404 when unconfigured.
 * `POST /logout`        — guarded, and mutating, so it carries a CSRF token like any other
 *                          mutation.
 * `GET  /session`       — guarded. Who am I, and is this cookie still worth anything.
 */

/** Where these routes belong, per docs/idea/04-api-keys-and-access.md#admin-api-route-groups. */
export const ADMIN_AUTH_BASE_PATH = "/api/admin/auth"

export interface AdminAuthRoutesDeps {
  readonly maximumJsonBytes?: number
  readonly service: AdminAuthService
  /** `Env.trustProxy`. Off by default: an unvetted `X-Forwarded-For` is a throttle bypass. */
  readonly trustProxy: boolean
  /**
   * `Env.trustProxyHops` (`TRUST_PROXY_HOPS`, default 1): how many proxies of ours append to
   * `X-Forwarded-For`. Read only when `trustProxy` is on.
   */
  readonly trustProxyHops?: number
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

export function adminAuthRoutes(deps: AdminAuthRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  const guard = adminAuth(deps.service, deps.sessionCookieInsecure, deps.apiToken ?? null)
  const trustedHops = deps.trustProxy ? (deps.trustProxyHops ?? 1) : 0

  routes.get("/methods", async (c) => c.json(await deps.service.methods()))

  routes.post("/login", async (c) => {
    const parsed = localLoginBody.safeParse(
      await readJsonBody(c.req.raw, { maximumBytes: deps.maximumJsonBytes ?? 8192 }),
    )
    if (!parsed.success) {
      // A malformed body is not a credential verdict, so it gets a 400 — but a
      // 400 that says nothing about what the verdict would have been.
      return refuse(c, 400, "Invalid request body", "invalid_request")
    }

    try {
      const result = await deps.service.completeLocalLogin({
        password: parsed.data.password,
        ip: clientIp(c, trustedHops),
      })
      setCookie(
        c,
        SESSION_COOKIE_NAME,
        result.cookieValue,
        sessionCookieOptions(result.cookieMaxAgeSeconds, deps.sessionCookieInsecure),
      )
      warnIfCookieUndeliverable(c, deps.sessionCookieInsecure)
      // The same body `/session` answers with, so the SPA adopts the session it
      // just minted without a second round trip.
      return c.json(sessionBody(result.session), 200)
    } catch (error) {
      if (error instanceof AdminLoginThrottledError) {
        c.header("Retry-After", String(error.retryAfterSeconds))
        return refuse(c, 429, ADMIN_LOGIN_FAILED_MESSAGE, null, lockout(error.retryAfterSeconds))
      }
      // Wrong password, no credential configured, anything else: one wording,
      // byte-identical to the OIDC callback's — see the service.
      return refuse(c, 401, ADMIN_LOGIN_FAILED_MESSAGE, "admin_auth_failed")
    }
  })

  routes.get("/oidc/start", async (c) => {
    if (!(await deps.service.methods()).oidc) return oidcNotConfigured(c)
    try {
      const { authorizeUrl } = await deps.service.startLogin(clientIp(c, trustedHops))
      return c.redirect(authorizeUrl, 302)
    } catch (error) {
      if (!(error instanceof AdminLoginThrottledError)) throw error
      c.header("Retry-After", String(error.retryAfterSeconds))
      return refuse(c, 429, ADMIN_LOGIN_FAILED_MESSAGE, null, lockout(error.retryAfterSeconds))
    }
  })

  routes.get("/oidc/callback", async (c) => {
    if (!(await deps.service.methods()).oidc) return oidcNotConfigured(c)
    const code = c.req.query("code")
    const state = c.req.query("state")
    const error = c.req.query("error")
    if (error !== undefined && error.length > 0) {
      // The IdP denied the authorization. Render the callback page with a
      // generic failure message — the operator sees the same wording as a
      // probe would.
      return c.html(callbackPage("Sign-in failed", ADMIN_LOGIN_FAILED_MESSAGE), 400)
    }
    if (code === undefined || code === "" || state === undefined || state === "") {
      return c.html(callbackPage("Sign-in failed", ADMIN_LOGIN_FAILED_MESSAGE), 400)
    }

    try {
      const result = await deps.service.completeLogin({
        code,
        state,
        ip: clientIp(c, trustedHops),
      })
      setCookie(
        c,
        SESSION_COOKIE_NAME,
        result.cookieValue,
        sessionCookieOptions(result.cookieMaxAgeSeconds, deps.sessionCookieInsecure),
      )
      warnIfCookieUndeliverable(c, deps.sessionCookieInsecure)
      return c.html(callbackPageSignedIn(), 200)
    } catch (err) {
      if (err instanceof AdminLoginThrottledError) {
        c.header("Retry-After", String(err.retryAfterSeconds))
        return c.html(callbackPage("Sign-in failed", ADMIN_LOGIN_FAILED_MESSAGE), 429)
      }
      // This route renders HTML, so it answers the failure itself rather than rethrowing into the
      // error handler — which means it owes the operator the line that handler would have written.
      // Skipping it is what made a rejected sign-in a dead end: the browser shows one deliberately
      // uninformative sentence, and without this there is nothing anywhere that says which check
      // rejected it. `reason` is the diagnostic kind; the response body still carries neither.
      c.get("log").warn("admin sign-in rejected at the OIDC callback", {
        component: "admin-auth",
        errorClass: err instanceof Error ? err.name : "unknown",
        errorCode: err instanceof AdminAuthError ? err.code : null,
        reason: err instanceof AdminAuthError ? err.reason : undefined,
        remedy: "docs/idea/13-admin-oidc.md#troubleshooting maps the kind to what to check",
      })
      return c.html(callbackPage("Sign-in failed", ADMIN_LOGIN_FAILED_MESSAGE), 401)
    }
  })

  routes.post("/logout", guard, async (c) => {
    const session = c.get("adminSession")
    // A static token is not a session and cannot be ended by a request. Saying so is the point:
    // answering `logged_out` would report a revocation that did not happen, and the caller would
    // go on holding a credential it believes it just surrendered. Revoking this one means changing
    // the variable and restarting the router.
    if (session.username === ADMIN_API_TOKEN_ACTOR) {
      return refuse(
        c,
        400,
        "ADMIN_API_TOKEN is a static credential, not a session — it is revoked by changing the variable and restarting the router",
        "invalid_request",
      )
    }

    // The source address rides along for the same reason login's does: the audit row for a
    // session ending is only useful next to the one that started it.
    // The username, so the row names the operator who ended *this* session rather than the admin
    // allowlist's first entry — `ADMIN_OIDC_ADMIN_EMAIL` may name several.
    await deps.service.logout(session.id, clientIp(c, trustedHops), session.username)
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

/**
 * The password door's body contract. Password-only: one principal, no username. Bounded well under
 * the body ceiling so a "password" cannot spend argon2's input buffer on a novel.
 */
const localLoginBody = z.object({
  password: z.string().min(1).max(1024),
})

/** OIDC absent is not an error — the door simply does not exist on this router. */
function oidcNotConfigured(c: Context<AdminAuthEnv>): Response {
  return refuse(c, 404, "Not found", "not_found")
}

/** A refusal: the sentence and code as before, `error.router` beside them. */
function refuse(
  c: Context<AdminAuthEnv>,
  status: 400 | 401 | 404 | 429,
  message: string,
  code: string | null,
  verdict: RouterVerdict = REQUEST_WALL,
): Response {
  return c.json(
    refusalBody(null, status, message, code, verdict, c.get("requestId") ?? null),
    status,
  )
}

/** The per-IP sign-in lockout: a clock clears it, at the `Retry-After` the response carries. */
function lockout(retryAfterSeconds: number): RouterVerdict {
  return { wall: "clock", scope: "request", retryAfterSeconds }
}

/**
 * The address the per-IP throttle and the audit row count against — one value, so one IP always
 * lands in one bucket. The rule (`TRUST_PROXY`, `TRUST_PROXY_HOPS`) is `admin-auth/clientIp.ts`.
 */
function clientIp(c: Context<AdminAuthEnv>, trustedHops: number): string {
  let socketAddress: string | undefined
  try {
    socketAddress = getConnInfo(c).remote.address
  } catch {
    // No Bun server behind this request — an `app.request(...)` call in a test. Every such
    // caller shares one bucket, which is the conservative direction to be wrong in.
    socketAddress = undefined
  }
  return resolveClientIp(c.req.header("x-forwarded-for"), socketAddress, trustedHops)
}
