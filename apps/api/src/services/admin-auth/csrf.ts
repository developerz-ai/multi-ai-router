import { timingSafeEqualStrings } from "./constantTime"
import type { AdminSession } from "./sessionStore"

/**
 * CSRF, the **synchronizer-token** pattern: the token is minted at login, stored *inside the
 * server-side session record*, and handed to the SPA in the login and session response bodies.
 * The SPA echoes it in `x-csrf-token` on every mutating admin request, and the middleware
 * compares it against the session's own copy in constant time.
 *
 * **Why synchronizer and not double-submit.** Double-submit compares a cookie against a header
 * and holds only if an attacker cannot write that cookie. On a real deployment they often can:
 * cookies ignore the origin's port and scheme, and any sibling host under the same registrable
 * domain — a stale subdomain, a static site, another app behind the same proxy — can set a
 * cookie that this origin will send back. The attacker then submits a matching pair and the
 * check passes. A synchronizer token has no such failure mode: the expected value lives in
 * server-side state the attacker cannot write, and it costs nothing extra here because that
 * state already exists for the session. (`__Host-` on the session cookie closes the same
 * cookie-injection hole from the other side; see `cookies.ts`.)
 *
 * **Why `SameSite=Strict` is not the answer on its own.** It is a *browser behavior*, not an
 * application invariant, and the invariant is what we are allowed to rely on. It is enforced by
 * the client we are trying to defend against being tricked; a browser that is old, embedded, or
 * configured with the protection relaxed simply does not apply it, and a non-browser client
 * never did. It also says nothing about a same-site attacker — a subdomain XSS or another app
 * on the same registrable domain is *same-site*, so `Strict` attaches the cookie happily. The
 * token is the half of the pair the server enforces itself.
 */

export const CSRF_HEADER = "x-csrf-token"

const CSRF_TOKEN_BYTES = 32

export function mintCsrfToken(): string {
  const bytes = new Uint8Array(CSRF_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

/** Methods that must carry a token. Everything else is a read and carries no side effect. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase())
}

export function csrfTokenMatches(session: AdminSession, presented: string | undefined): boolean {
  if (presented === undefined || presented.length === 0) return false
  return timingSafeEqualStrings(presented, session.csrfToken)
}
