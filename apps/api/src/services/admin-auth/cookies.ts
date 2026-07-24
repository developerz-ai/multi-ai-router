/**
 * The session cookie's shape, as plain data — the transport layer is what actually writes a
 * header (CLAUDE.md: nothing outside transport touches Hono), so this module only decides the
 * attributes and `routes/admin/auth.ts` hands them to `hono/cookie`.
 *
 * Attributes are fixed, not configurable, because every one of them is a security property from
 * docs/idea/04-api-keys-and-access.md#session-cookie and a knob is only ever used to turn one
 * off:
 *
 * | `httpOnly`        | no script reads it, so an XSS cannot exfiltrate the session
 * | `SameSite=Strict` | no cross-site navigation or form post carries it (first line, not the
 * |                   | only one — the CSRF token in `csrf.ts` is the invariant we enforce)
 * | `Secure`          | always. HTTPS is assumed in front (07-security.md); a cookie that would
 * |                   | ride plaintext is worse than a login prompt
 * | `Path=/`          | SPA and API share an origin
 * | `__Host-` prefix  | host-only, `Path=/`, `Secure` — enforced by the *browser*. It is what
 * |                   | stops a sibling subdomain from injecting a session cookie into this
 * |                   | origin, which is the same attack that makes double-submit CSRF unsound
 */

/** Base name. The `__Host-` prefix is applied by the cookie helper's `prefix: "host"`. */
export const SESSION_COOKIE_NAME = "mar_admin_session"

/** The name as it appears on the wire, for tests and for anything reading a raw header. */
export const SESSION_COOKIE_FULL_NAME = `__Host-${SESSION_COOKIE_NAME}`

export interface SessionCookieOptions {
  readonly prefix: "host"
  readonly httpOnly: true
  readonly secure: true
  readonly sameSite: "Strict"
  readonly path: "/"
  readonly maxAge: number
}

/**
 * `maxAge` mirrors the sliding idle window rather than the absolute one: the browser should
 * forget the cookie on the same schedule the server forgets the session. The server remains the
 * authority either way — a cookie that outlives its session record authenticates nothing.
 */
export function sessionCookieOptions(maxAgeSeconds: number): SessionCookieOptions {
  return {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: maxAgeSeconds,
  }
}
