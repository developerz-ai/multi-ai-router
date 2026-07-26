import { AdminAuthError, ROUTER_KEY_PREFIX } from "@multi-ai-router/core"
import type { MiddlewareHandler } from "hono"
import { getCookie } from "hono/cookie"
import {
  type AdminAuthService,
  type AdminSession,
  CSRF_HEADER,
  isMutatingMethod,
  SESSION_COOKIE_NAME,
  sessionCookiePrefix,
} from "../services/admin-auth"
import type { AppEnv } from "../types"

/**
 * The guard on every admin route. Three checks, in this order:
 *
 * 1. **A router API key is refused outright.** The two credential spaces never overlap
 *    (04-api-keys-and-access.md#two-planes): a `mar_live_…` key authenticates `/v1/**` and
 *    nothing else, under no scope, flag, or configuration. The check is a rejection rather than
 *    an ignore, and it runs *before* the cookie is read, so a request cannot arrive holding both
 *    credentials and be admitted on the strength of one of them. There is deliberately no code
 *    path from here into key verification.
 * 2. **The session cookie** resolves to live server-side state, or the request is 401.
 * 3. **CSRF** on every mutating method, because `SameSite=Strict` is a browser behavior and this
 *    is the application invariant — see the reasoning in `services/admin-auth/csrf.ts`.
 *
 * `sessionCookieInsecure` is the reader half of `services/admin-auth/cookies.ts`: the prefix
 * decides which key `getCookie` looks up, so the guard has to be built from the same value the
 * login route writes under. It is required, not defaulted, for the reason the guard itself is
 * required on every route factory — a mount cannot silently be wired half-right.
 */

/** `AppEnv` plus the session the guard resolved. Transport-only, like `AppEnv` itself. */
export interface AdminAuthEnv extends AppEnv {
  Variables: AppEnv["Variables"] & {
    adminSession: AdminSession
  }
}

const ROUTER_KEY_REJECTED = "A router API key cannot authenticate the admin plane"

export function adminAuth(
  service: AdminAuthService,
  sessionCookieInsecure: boolean,
): MiddlewareHandler<AdminAuthEnv> {
  const prefix = sessionCookiePrefix(sessionCookieInsecure)

  return async (c, next) => {
    if (presentsRouterKey(c.req.header("authorization"), c.req.header("x-api-key"))) {
      throw new AdminAuthError(ROUTER_KEY_REJECTED)
    }

    const session = await service.authenticate(getCookie(c, SESSION_COOKIE_NAME, prefix))

    if (isMutatingMethod(c.req.method)) {
      service.assertCsrf(session, c.req.header(CSRF_HEADER))
    }

    c.set("adminSession", session)
    await next()
  }
}

/**
 * Prefix match, not `isRouterKey`: a truncated, mangled, or expired-looking `mar_live_…` value
 * is still an attempt to authenticate the admin plane with a data-plane credential, and it gets
 * the same answer as a well-formed one.
 */
function presentsRouterKey(authorization: string | undefined, apiKey: string | undefined): boolean {
  const bearer = authorization?.replace(/^Bearer\s+/i, "")
  return looksLikeRouterKey(bearer) || looksLikeRouterKey(apiKey)
}

function looksLikeRouterKey(value: string | undefined): boolean {
  return value?.trim().startsWith(ROUTER_KEY_PREFIX) ?? false
}
