/**
 * The session cookie's shape, as plain data — the transport layer is what actually writes a
 * header (CLAUDE.md: nothing outside transport touches Hono), so this module only decides the
 * attributes and `routes/admin/auth.ts` hands them to `hono/cookie`.
 *
 * Every attribute is a security property from docs/idea/04-api-keys-and-access.md#session-cookie,
 * so none of them is individually configurable — a knob on one of these is only ever used to turn
 * it off:
 *
 * | `httpOnly`        | no script reads it, so an XSS cannot exfiltrate the session
 * | `SameSite=Strict` | no cross-site navigation or form post carries it (first line, not the
 * |                   | only one — the CSRF token in `csrf.ts` is the invariant we enforce)
 * | `Path=/`          | SPA and API share an origin
 * | `Secure`          | HTTPS is assumed in front (07-security.md); a cookie that would ride
 * |                   | plaintext is worse than a login prompt
 * | `__Host-` prefix  | host-only, `Path=/`, `Secure` — enforced by the *browser*. It is what
 * |                   | stops a sibling subdomain from injecting a session cookie into this
 * |                   | origin, which is the same attack that makes double-submit CSRF unsound
 *
 * The last two, and only those two, come off together under `SESSION_COOKIE_INSECURE`. The escape
 * hatch exists because the plain-HTTP LAN install (`http://192.168.1.50:8080`) is a real way this
 * router is run, and the hardened cookie makes it **unusable with no diagnosis**: a browser
 * silently discards a `Secure` cookie delivered over `http://`, so login answers `200`, every
 * request after it is `401`, and nothing in the console, the log, or the response says why. They
 * come off together because they cannot come off separately — the `__Host-` prefix is honored
 * only on a cookie that carries `Secure`, so keeping the prefix would discard the cookie anyway.
 *
 * What survives the escape hatch is everything that does not depend on the transport: `HttpOnly`,
 * `SameSite=Strict`, `Path=/`, the server-side session record, and the CSRF token on every
 * mutation. What is given up is confidentiality on the wire and the sibling-host injection
 * defence — which is why it defaults to off and `main.ts` names the risk at `warn` on every boot.
 */

/** Base name. The `__Host-` prefix is applied by the cookie helper's `prefix: "host"`. */
export const SESSION_COOKIE_NAME = "mar_admin_session"

/**
 * The prefix the cookie helper applies — for the writer and, just as importantly, the reader:
 * `getCookie` looks up a *different key* per prefix, so `middleware/adminAuth.ts` has to be told
 * the same mode `routes/admin/auth.ts` wrote under. Both derive it from here, from the one
 * boolean threaded out of `Env`, so they cannot disagree.
 */
export function sessionCookiePrefix(insecure: boolean): "host" | undefined {
  return insecure ? undefined : "host"
}

/** The name as it appears on the wire, for tests and for anything reading a raw header. */
export function sessionCookieFullName(insecure: boolean): string {
  return insecure ? SESSION_COOKIE_NAME : `__Host-${SESSION_COOKIE_NAME}`
}

export interface SessionCookieOptions {
  /** Absent in the insecure mode: the prefix is only honored alongside `Secure`. */
  readonly prefix?: "host"
  readonly httpOnly: true
  readonly secure: boolean
  readonly sameSite: "Strict"
  readonly path: "/"
  readonly maxAge: number
}

/**
 * `maxAge` mirrors the sliding idle window rather than the absolute one: the browser should
 * forget the cookie on the same schedule the server forgets the session. The server remains the
 * authority either way — a cookie that outlives its session record authenticates nothing.
 *
 * `insecure` is required rather than defaulted, so adding a caller is a decision about the
 * transport rather than an accident of a signature.
 */
export function sessionCookieOptions(
  maxAgeSeconds: number,
  insecure: boolean,
): SessionCookieOptions {
  return {
    prefix: sessionCookiePrefix(insecure),
    httpOnly: true,
    secure: !insecure,
    sameSite: "Strict",
    path: "/",
    maxAge: maxAgeSeconds,
  }
}
