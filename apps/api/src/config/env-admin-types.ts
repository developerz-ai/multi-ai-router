/**
 * The four knobs an OIDC admin login needs at boot. The router does not
 * implement the protocol itself — it relies on the IdP's discovery document
 * for the endpoint URLs — so the configuration here is the *identity* of the
 * issuer and the *principal* we are willing to admit. The IdP is the source of
 * truth for everything else.
 *
 * `adminSubject` is optional: the `email` is the primary check, and the
 * `sub` is the optional stricter one. Pinning subject matters when the IdP
 * reuses emails across tenants; the operator who needs that can set it.
 */
export interface AdminOidcConfig {
  /** Exactly the issuer URL. Compared with the discovery doc and `id_token.iss`. */
  readonly issuerUrl: string
  /** The OAuth client id the router registered with the IdP. */
  readonly clientId: string
  /** The OAuth client secret. Null for a public client. */
  readonly clientSecret: string | null
  /** The redirect URI the IdP will return the browser to. */
  readonly redirectUri: string
  /**
   * The emails the IdP may assert for the admin to be admitted, lowercased and
   * deduplicated at parse time. Never empty when this config exists.
   *
   * A list rather than one string because a self-hosted router is normally run
   * by a *team* — every operator has their own IdP identity, and pinning one
   * email means everyone else shares a credential or nobody else gets in. This
   * is **not** multi-user: there are no user rows, no roles and no per-person
   * state. Every entry maps onto the same single admin principal and the same
   * session model, exactly as the single email did.
   */
  readonly adminEmails: readonly string[]
  /** Optional stricter: the `sub` claim must equal this value. */
  readonly adminSubject: string | null
  /**
   * Scopes to request. `openid` is mandatory; everything else is passed
   * through to the IdP. Defaults to `openid profile email`.
   */
  readonly scopes: readonly string[]
  /** Maximum tolerated clock skew between the router and the IdP, in seconds. */
  readonly clockSkewSeconds: number
  /** Deadline for each IdP discovery, JWKS or token request. */
  readonly requestTimeoutMs: number
}

/**
 * Admin-plane session policy: the login-throttle windows, and the one transport
 * decision the session cookie cannot make for itself. Grouped like
 * `RetentionConfig` rather than flattened onto `Env`, because they are one
 * policy read by one consumer (`services/admin-auth`).
 *
 * All six are optional: the documented happy path stays three hand-set
 * variables plus `docker compose up`.
 *
 * Deliberately NOT `retention.sessionsHours` — that is the *conversation*
 * sticky-session TTL for routing, a different thing that merely shares a word.
 */
export interface AdminAuthConfig {
  /** Sliding idle window; also the session cookie's `Max-Age`. */
  readonly sessionIdleMinutes: number
  /** Hard cap on total session life regardless of activity. A purely sliding session is one a thief renews forever. */
  readonly sessionAbsoluteHours: number
  /** Failed logins per throttle key before it locks. */
  readonly loginMaxAttempts: number
  readonly loginMaxConcurrent: number
  readonly loginMaxTrackedIps: number
  /** Failures older than this stop counting toward the lock. */
  readonly loginAttemptWindowMinutes: number
  /** How long a tripped throttle key stays locked. */
  readonly loginLockoutMinutes: number
  /**
   * How long a session's idle-window slide may go unpersisted. Must be shorter than the idle
   * window so a persisted session cannot expire before its next slide. `0` persists every slide.
   */
  readonly sessionTouchIntervalSeconds: number
  /**
   * Sessions the durable store keeps warm in memory per replica, so `authenticate()` never reads
   * Postgres for a session it has already seen. Sized for one operator with a few browsers; the
   * table is the truth, the cache is only what stops a read per admin request.
   */
  readonly sessionCacheMax: number
  /** Maximum time before this replica rechecks durable session revocation. */
  readonly sessionRevalidateSeconds: number
  /**
   * Drops `Secure` and the `__Host-` prefix from the session cookie. Off by
   * default and warned about at boot: it is the escape hatch for a plain-HTTP
   * LAN install (`http://192.168.1.50:8080`), where the hardened cookie is
   * discarded by the browser and login fails with nothing explaining why.
   * `HttpOnly`, `SameSite=Strict` and the CSRF token are unaffected — see
   * `services/admin-auth/cookies.ts`.
   */
  readonly sessionCookieInsecure: boolean
  /**
   * `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC`. Opts out of the fail-closed rule that
   * refuses to boot when a local admin password exists and `PUBLIC_URL` is not
   * loopback (`services/admin-auth/boot.ts`). Off by default; setting it is the
   * operator stating by name that a password-only door on a public address is
   * acceptable to them, and boot warns about it every time.
   */
  readonly localLoginAllowPublic: boolean
}
