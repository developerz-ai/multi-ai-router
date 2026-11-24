import { AdminAuthError, describeError } from "@multi-ai-router/core"
import type { Context } from "hono"
import { REQUEST_WALL, refusalBody } from "../../errors/render"
import type { RouterVerdict } from "../../errors/router-object"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import {
  ADMIN_LOGIN_UNAVAILABLE_MESSAGE,
  AdminAuthUnavailableError,
} from "../../services/admin-auth"

/** OIDC absent is not an error — the door simply does not exist on this router. */
export function oidcNotConfigured(c: Context<AdminAuthEnv>): Response {
  return refuse(c, 404, "Not found", "not_found")
}

/** A refusal: the sentence and code as before, `error.router` beside them. */
export function refuse(
  c: Context<AdminAuthEnv>,
  status: 400 | 401 | 404 | 429 | 503,
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
export function lockout(retryAfterSeconds: number): RouterVerdict {
  return { wall: "clock", scope: "request", retryAfterSeconds }
}

/** How long a caller waits after a sign-in the router could not judge. */
const UNAVAILABLE_RETRY_SECONDS = 5

/**
 * A sign-in that failed for a reason that is not the caller's: the store or the IdP did not answer.
 * `AdminAuthError` is a verdict; everything else reaching these routes is an outage, and answering
 * it 401 sends an operator looking for a wrong password.
 */
export function isSignInOutage(error: unknown): boolean {
  return !(error instanceof AdminAuthError)
}

export function logSignInOutage(c: Context<AdminAuthEnv>, door: string, error: unknown): void {
  const known = error instanceof AdminAuthUnavailableError
  const cause = known ? (error.cause ?? error) : error
  c.get("log").error("admin sign-in could not be judged", {
    component: "admin-auth",
    door,
    errorClass: cause instanceof Error ? cause.name : "unknown",
    reason: (known ? error.reason : undefined) ?? describeError(cause, 500),
    remedy: "docs/idea/13-admin-oidc.md#troubleshooting",
  })
}

export function refuseUnavailable(c: Context<AdminAuthEnv>): Response {
  c.header("Retry-After", String(UNAVAILABLE_RETRY_SECONDS))
  return refuse(
    c,
    503,
    ADMIN_LOGIN_UNAVAILABLE_MESSAGE,
    "admin_auth_unavailable",
    lockout(UNAVAILABLE_RETRY_SECONDS),
  )
}

/** The IdP's own `error` code for the log: the OAuth token charset, or nothing recognizable. */
export function idpErrorCode(value: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unrecognized"
}
