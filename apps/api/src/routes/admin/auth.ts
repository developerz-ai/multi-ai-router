import { type Context, Hono } from "hono"
import { getConnInfo } from "hono/bun"
import { deleteCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import { renderErrorBody } from "../../errors/render"
import { type AdminAuthEnv, adminAuth } from "../../middleware/adminAuth"
import {
  type AdminAuthService,
  type AdminSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
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
}

const loginSchema = z.object({
  // Bounded on both sides: argon2id over an unbounded password is a denial-of-service vector,
  // and the length limit is never a hint about the configured credential.
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
})

export function adminAuthRoutes(deps: AdminAuthRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  const guard = adminAuth(deps.service)

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
      sessionCookieOptions(result.cookieMaxAgeSeconds),
    )
    return c.json(sessionBody(result.session))
  })

  routes.post("/logout", guard, async (c) => {
    await deps.service.logout(c.get("adminSession").id)
    deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(0))
    return c.json({ status: "logged_out" })
  })

  routes.get("/session", guard, (c) => c.json(sessionBody(c.get("adminSession"))))

  return routes
}

/**
 * The SPA reads `csrfToken` from here and echoes it on every mutation. It is safe in a response
 * body and unsafe in a readable cookie for the same reason: the body is protected by the same
 * origin policy, a cookie is shared with every sibling host — see `services/admin-auth/csrf.ts`.
 */
function sessionBody(session: AdminSession): Record<string, string> {
  return {
    username: session.username,
    csrfToken: session.csrfToken,
    issuedAt: new Date(session.createdAtMs).toISOString(),
    expiresAt: new Date(sessionExpiryMs(session)).toISOString(),
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
