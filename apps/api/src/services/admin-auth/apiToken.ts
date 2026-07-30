import { ROUTER_KEY_PREFIX } from "@multi-ai-router/core"
import { timingSafeEqualStrings } from "./constantTime"
import type { AdminSession } from "./sessionStore"

/**
 * `ADMIN_API_TOKEN` — the admin plane's **non-browser** credential.
 *
 * The admin plane has always been a real REST API; what it had no way to accept was a caller that
 * is not a browser. A session cookie is minted by a login, lives in memory, dies on restart, and
 * carries a CSRF token the caller has to echo — workable for the console, and the wrong shape for
 * a deploy script, a CI job, a Terraform provider, or an agent driving the router. This is the same
 * answer `METRICS_TOKEN` gives Prometheus: one static bearer, set by the operator, checked in
 * constant time (`routes/metrics.ts`).
 *
 * **Three planes now, still disjoint.** A router key (`mar_live_…`) authenticates `/v1/**` and is
 * refused by the admin guard before this is even consulted; this token authenticates
 * `/api/admin/**` and has no path into key verification; `METRICS_TOKEN` reads `/metrics` and
 * nothing else. No credential here is accepted by two planes, under any flag
 * (04-api-keys-and-access.md#two-planes).
 *
 * **Unset is the default and the safe one.** No token means the admin plane is browser-only,
 * exactly as before — this adds a credential, it does not enable one.
 */

/**
 * The floor on entropy, and not a stylistic minimum. Browser entry into the admin plane is
 * rate-limited by client IP before OIDC state creation or code exchange
 * (`services/admin-auth/throttle.ts`). A static bearer has none of that — it is checked and
 * answered on every request, forever, at whatever rate the network allows. Length is therefore the
 * only thing standing between this token and an unbounded guessing budget, so boot refuses a short
 * one by name rather than letting an operator paste `hunter2` into a production control plane.
 *
 * 32 characters of the generated base64url below is 192 bits.
 */
export const ADMIN_API_TOKEN_MIN_LENGTH = 32

/**
 * What the audit trail and `GET /api/admin/auth/session` call this caller. Deliberately not the
 * OIDC principal: an operator reading the log has to distinguish a browser session from a script
 * holding the token, because revoking them differs — one happens at the IdP, the other is an env var
 * change and a restart.
 */
export const ADMIN_API_TOKEN_ACTOR = "admin-api-token"

/** A token an operator did not supply is not a token this ever matches. */
export function isAdminApiTokenConfigured(token: string | null): token is string {
  return token !== null && token.length > 0
}

/**
 * Boot-time validation, as a pure predicate so `config/env.ts` can refuse the value by name and
 * a test can assert the rule without an environment.
 *
 * The prefix check is the one that is easy to miss. A token beginning `mar_live_` would be
 * rejected by the admin guard as a *data-plane* credential before ever reaching the comparison
 * below — the operator would have configured a credential that authenticates nothing and be
 * debugging a `401` against a token the router can see is correct. Refusing it at boot turns a
 * silent dead end into a message naming the variable.
 */
export function adminApiTokenProblem(token: string): string | null {
  if (token.length < ADMIN_API_TOKEN_MIN_LENGTH) {
    return `must be at least ${ADMIN_API_TOKEN_MIN_LENGTH} characters: this credential is not rate-limited, so its length is its only defense against guessing`
  }
  if (token.startsWith(ROUTER_KEY_PREFIX)) {
    return `must not begin with "${ROUTER_KEY_PREFIX}": that prefix marks a data-plane router key, which the admin guard refuses outright — this token would authenticate nothing`
  }
  return null
}

/**
 * The synthesized session a token-authenticated request runs under. It is never stored, never
 * issued an id anything can revoke, and never slides: it exists for the duration of one request so
 * that everything downstream of the guard sees the same `AdminSession` shape whether the caller
 * was a browser or a script.
 *
 * `csrfToken` is empty **on purpose**, and it is what makes a stolen-token replay no worse than the
 * token itself: CSRF defends against a browser attaching *ambient* authority to a request the user
 * did not intend, and a bearer token is not ambient — no browser attaches it to a cross-site
 * request on its own. Demanding one here would also be unsatisfiable, since minting a CSRF token
 * requires the login this credential exists to avoid. The empty value can never be *matched*
 * either: `csrfTokenMatches` rejects an empty presented token before it compares anything.
 */
export function adminApiTokenSession(nowMs: number): AdminSession {
  return {
    id: ADMIN_API_TOKEN_ACTOR,
    username: ADMIN_API_TOKEN_ACTOR,
    csrfToken: "",
    createdAtMs: nowMs,
    lastSeenAtMs: nowMs,
    // A static credential has no idle or absolute bound — it is valid until the operator changes
    // the variable. Saying so with `Infinity` is honest; a far-future instant would be a lie the
    // console would render as a countdown.
    idleExpiryMs: Number.POSITIVE_INFINITY,
    absoluteExpiryMs: Number.POSITIVE_INFINITY,
  }
}

/**
 * Whether this request presented the configured token. Constant-time, for the same reason the
 * router-key and metrics comparisons are: an endpoint's guessability should not depend on how
 * early a byte differs.
 */
export function adminApiTokenMatches(configured: string | null, presented: string | null): boolean {
  if (!isAdminApiTokenConfigured(configured)) return false
  if (presented === null || presented.length === 0) return false
  return timingSafeEqualStrings(configured, presented)
}
