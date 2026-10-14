# Admin sign-in

Status: **implemented**. The admin console has two sign-in paths, either of which is sufficient on its own:

1. **Generic OIDC** — an authorization-code flow with PKCE against any standards-compliant provider. This is the recommended path for anything reachable by more than one machine: the sign-in guarding your console is then your identity provider's, with its MFA and its audit trail behind it.
2. **Local admin password** — an operator-set password stored as an argon2id hash in Postgres, created with `bin/admin set-password`. Off by default, intended for own-machine use, and fail-closed on a public address (see below).

`ADMIN_API_TOKEN` remains the separate break-glass credential for scripts and recovery.

Boot requires **at least one** of the two. A fresh database with no `ADMIN_OIDC_*` variables and no password row refuses to start, naming both remedies. A *partial* OIDC block fails the same fast env validation it always did, pointing here: once any of them is set, `ADMIN_OIDC_ISSUER_URL`, `ADMIN_OIDC_CLIENT_ID` and `ADMIN_OIDC_REDIRECT_URI` are required, plus at least one principal gate — `ADMIN_OIDC_ADMIN_EMAIL`, `ADMIN_OIDC_REQUIRED_CLAIMS`, or both. Neither gate set is refused naming both.

The router is an OIDC relying party, not an identity provider. Any standards-compliant provider that exposes discovery metadata and signs ID tokens with RS256 can be used without code changes. Zitadel is the production-tested provider; Keycloak, Authentik, and Auth0 use the same configuration contract.

## Security boundary

This remains a single-admin, self-hosted product. Both sign-in paths mint the same bounded session for the same single principal; neither adds users, organizations, or RBAC.

`ADMIN_OIDC_ADMIN_EMAIL` is an allowlist, not one address, because a self-hosted router is normally run by a team: every operator has their own identity at the IdP, and pinning one email means the others share a credential or nobody else gets in. Each entry still maps onto the **same** admin principal — there are no user rows, no roles, and no per-person state. What is per-person is attribution: the session and every audit row carry the email the IdP actually asserted, never the allowlist's first entry.

A successful OIDC callback must satisfy every check:

1. The authorization `state` exists, is unexpired, and is consumed exactly once.
2. The code exchange uses PKCE S256 and the configured redirect URI.
3. The ID token signature verifies against the issuer's JWKS.
4. `iss`, `aud`, `exp`, `iat`, and `nonce` match the current flow.
5. The token contains `email` and `email_verified: true`.
6. When `ADMIN_OIDC_ADMIN_EMAIL` is set, the asserted email matches one entry case-insensitively.
7. When `ADMIN_OIDC_REQUIRED_CLAIMS` is set, every `name=value` pair matches a claim of the verified ID token (below).
8. When `ADMIN_OIDC_ADMIN_SUBJECT` is set, `sub` matches it exactly.

Checks 6 and 7 are both gates, not alternatives: with both variables set, a sign-in must pass both. Adding required claims to an email-allowlist deployment can only narrow who gets in, never widen it.

### Claim-based admission

`ADMIN_OIDC_REQUIRED_CLAIMS` admits by what the IdP says a user *is* rather than by who they are — for an IdP that issues a claim such as `kind: "dev_user"` to staff, `ADMIN_OIDC_REQUIRED_CLAIMS=kind=dev_user` admits any staff user without an email list to maintain. It is IdP-agnostic: any claim the provider signs into the ID token can be named (`groups=router-admins` for a provider that emits groups).

| Rule | Behavior |
|---|---|
| Syntax | Comma-separated `name=value` pairs; names and values trimmed; the value is everything after the first `=` (it may contain `=`, never a comma). Empty entries are dropped, exact duplicates collapse. |
| Malformed | `kind` (no `=`), `=x` (no name), `kind=` (no value), or a value naming no pair (`","`) fails boot. |
| Every pair | All pairs must match. Two pairs with the same name both apply (only satisfiable by an array claim). |
| String claim | Matches when exactly equal to the value — case-sensitive. |
| Array claim | Matches when some element is exactly equal to the value. |
| Missing claim | Rejected. |
| Any other shape | Number, boolean, object or `null`: rejected; the router never coerces. |
| Source | The **verified** ID token only — signature, `iss`, `aud`, `exp`, `iat` and `nonce` already checked. Never userinfo, never an unverified decode. |
| `email_verified` | Still required. The admitted email is still the session's and the audit row's identity. |

A claim rejection is a `principal` failure exactly like an email mismatch: the same browser sentence, the same `warn` line and `admin.login_failed` row. Its reason names the claim and the configured value, never the token's own value.

It is still one admin principal. A claim admits a human to the same single session model; it does not create users, roles, or per-claim permissions.

### Trusting the IdP's user gating

`ADMIN_OIDC_REQUIRED_CLAIMS` on its own delegates the admission decision to the identity provider: anyone the IdP will sign an ID token for, carrying that claim, for this client, becomes the router's admin. That is only as safe as the IdP's own gating. Use it alone only when:

- the IdP client registered for the router itself restricts who can authenticate (for example, a client only staff accounts can sign in to), so a non-staff account is refused at the IdP and never reaches the callback;
- the claim is one the IdP sets from its own records, never something a user can edit about themselves (a self-service profile field is not a gate);
- the claim's meaning is stable — if the IdP later issues the same value to a broader population, the router's admin set widens with it, silently.

When any of those is in doubt, set `ADMIN_OIDC_ADMIN_EMAIL` as well: both gates then apply, and the claim narrows the allowlist rather than replacing it.

Every rejection — from either path — returns the same operator-facing sentence. Detailed claim failures are server-side diagnostics, never a browser-visible oracle.

Server-side means two records, both structured, neither reaching the browser:

- a `warn` log line, `component: "admin-auth"`, carrying the diagnostic `reason` and the request's `requestId`;
- an `admin.login_failed` audit row with `method: "oidc"` and the same `reason`. Its `subjectId` is `unknown` — a rejected sign-in is one where the router never accepted an identity, so attributing the row to a configured operator would be a fabrication.

## Local admin password

The password door exists so a laptop evaluation or a two-person shop without an IdP can sign in at all. It is deliberately shaped to avoid what killed `ADMIN_PASSWORD` (#42): the credential is **never env-var-shaped**. It lives only as an argon2id hash in the `admin_credentials` table — never in `.env`, a compose file, an image layer, a log line, or any API response.

| Property | Rule |
|---|---|
| Enable | `bin/admin set-password` — interactive hidden prompt, typed twice (never an argv value; piped stdin of two lines also works for automation). The hash is computed and written at run time. |
| Disable | `bin/admin delete-password` — removes the hash row. The door's existence *is* the row; there is no enable flag anywhere. |
| Enabled by default | **No.** A fresh database has no row, so the door is off until an operator opens it. |
| Recovery | Re-run `bin/admin set-password` — it replaces the hash idempotently. `ADMIN_API_TOKEN` is unaffected by both verbs. |
| Password policy | 12–128 characters, enforced by the verb. |
| Login surface | Password-only — no username field, because there is one principal. `POST /api/admin/auth/login`. |
| Throttling | Per client IP on the login-throttle seam: failed attempts lock the address after `ADMIN_LOGIN_MAX_ATTEMPTS` within `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES`, for `ADMIN_LOGIN_LOCKOUT_MINUTES`. A locked address gets `429` + `Retry-After`. |
| Failure wording | One generic sentence, byte-identical to the OIDC callback's. A wrong password, an unconfigured door, and a locked address are indistinguishable to a prober; the audit log carries the real kind. |
| Session | Identical to the OIDC one — same `__Host-` cookie, same sliding/absolute bounds, same CSRF. A second way to *obtain* the session, not a second session model. |

### Fail closed on a public address

A password has no IdP and no MFA in front of it, so the honest default is **this machine only**. Boot **refuses** when a hash row exists and `PUBLIC_URL` is set to anything that is not positively loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) — an unparseable or private-range address counts as public, because the safe direction to be wrong is the refusal.

The escape hatch is explicit: set `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC=true` and boot proceeds, with a `warn` line on every boot naming the risk. Use it for a LAN install behind its own firewall, not for an internet-facing console — that deployment wants OIDC.

Changes take effect without a restart in both directions: the router reads the row per login, so `bin/admin set-password` opens the door and `bin/admin delete-password` closes it against the *next* attempt. The boot refusal is the one exception — it is a boot-time posture check, so changing `PUBLIC_URL` or the override still asks for a restart.

## Register the OIDC client

Create a confidential web OIDC client at the identity provider:

| Setting | Value |
|---|---|
| Flow | Authorization Code |
| PKCE | Required, S256 |
| Redirect URI | `https://router.example.com/api/admin/auth/oidc/callback` |
| Scopes | `openid profile email` |
| ID-token signing | RS256 |
| User claims | Include `email` and `email_verified` in the ID token |

The redirect URI is an exact match. Replace `router.example.com` with the router's HTTPS origin; do not add or remove a trailing slash.

Some providers expose the last requirement as “include user info in ID token” or “ID token userinfo assertion.” Enable it when claims requested through the `email` scope would otherwise be available only from the userinfo endpoint. The router deliberately validates the signed ID token and does not fetch a second principal from userinfo.

For every configured administrator, verify the provider records the email as verified. Prefer also setting `ADMIN_OIDC_ADMIN_SUBJECT` after the first enrollment: email is the required human-readable pin, while `sub` adds an immutable provider-specific pin. It pins **one** subject, so it fits a single-operator deployment; with several allowed emails, leave it unset and let the email allowlist be the pin.

## Configure the router for OIDC

```dotenv
ADMIN_OIDC_ISSUER_URL=https://sso.example.com
ADMIN_OIDC_CLIENT_ID=multi-ai-router
ADMIN_OIDC_CLIENT_SECRET=replace-with-client-secret
ADMIN_OIDC_REDIRECT_URI=https://router.example.com/api/admin/auth/oidc/callback
# Comma-separated: one entry per operator, all mapping onto the single admin principal.
ADMIN_OIDC_ADMIN_EMAIL=admin@example.com,second.operator@example.com
# And/or claim-based admission; with both set, both must pass.
# ADMIN_OIDC_REQUIRED_CLAIMS=kind=dev_user
# ADMIN_OIDC_ADMIN_SUBJECT=provider-subject-id
# ADMIN_OIDC_SCOPES=openid profile email
# ADMIN_OIDC_CLOCK_SKEW_SECONDS=60
```

| Variable | Required | Meaning |
|---|---|---|
| `ADMIN_OIDC_ISSUER_URL` | for OIDC | Exact OIDC issuer. Discovery is fetched from `/.well-known/openid-configuration`; the returned `issuer` must match. |
| `ADMIN_OIDC_CLIENT_ID` | for OIDC | Client identifier and expected ID-token audience. |
| `ADMIN_OIDC_CLIENT_SECRET` | no | Confidential-client secret. Omit only for a public client; PKCE remains mandatory either way. |
| `ADMIN_OIDC_REDIRECT_URI` | for OIDC | Exact callback URI registered with the provider. |
| `ADMIN_OIDC_ADMIN_EMAIL` | for OIDC: this, `ADMIN_OIDC_REQUIRED_CLAIMS`, or both | Comma-separated emails allowed to receive an admin session. Compared case-insensitively; entries are trimmed, lowercased, and deduplicated at boot. A value naming no email at all (`","`) is refused at boot rather than left to fail every login. |
| `ADMIN_OIDC_REQUIRED_CLAIMS` | for OIDC: this, `ADMIN_OIDC_ADMIN_EMAIL`, or both | Comma-separated `name=value` pairs the verified ID token must all satisfy — see [Claim-based admission](#claim-based-admission). Safe alone only under [the IdP's user gating](#trusting-the-idps-user-gating). Malformed pairs fail boot. |
| `ADMIN_OIDC_ADMIN_SUBJECT` | no | Additional exact match against `sub`. Recommended once known. |
| `ADMIN_OIDC_SCOPES` | no | Space-separated scopes. Default `openid profile email`; `openid` is mandatory. |
| `ADMIN_OIDC_CLOCK_SKEW_SECONDS` | no | Accepted clock skew for token timestamps. Default `60`; zero is refused. |
| `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` | no | `true` opts out of the fail-closed loopback rule for the local password. Default `false`; boot warns every time it is on. |

The OIDC block is all-or-nothing: all absent means "OIDC off, local password only"; a partial block — including one with neither `ADMIN_OIDC_ADMIN_EMAIL` nor `ADMIN_OIDC_REQUIRED_CLAIMS` — fails env validation naming what is missing. Whether *some* sign-in method exists is decided after migrations, because the local credential's existence is a database row — the refusal names both remedies and points here.

## Session and callback behavior

`GET /api/admin/auth/oidc/start` creates a ten-minute, one-shot state row containing the PKCE verifier and nonce, then redirects to the provider. `GET /api/admin/auth/oidc/callback` consumes that state and validates its binding before any discovery, code exchange or JWKS request. Unknown, expired and replayed state never contacts the IdP, even after a process restart. The callback then exchanges the code, verifies the ID token, and issues the bounded admin session. A valid state stays consumed if a later IdP request fails; the operator starts a fresh sign-in. Both routes answer `404` when OIDC is not configured. `POST /api/admin/auth/login` verifies the password against the stored argon2id hash and issues the identical session. `GET /api/admin/auth/methods` is public and reports which paths exist (`{ "oidc": bool, "local": bool }`) — it is how the login page knows what to render.

On success the callback sets the cookie and sends the browser to `/`. The hop is client-side, not a `302`, and for the same reason the route is unguarded: this response is the tail of a cross-site chain that began at the provider, so a server-issued redirect can produce a follow-up request that arrives *without* the cookie just set — the console would bounce to `/login` and read as a failed sign-in. A navigation issued by the callback document itself is same-origin and self-initiated, which carries a Strict cookie. A visible link covers the no-JS case.

The callback is intentionally unguarded: a cross-site top-level redirect cannot carry the `SameSite=Strict` session cookie. The one-shot state, nonce, PKCE verifier, and principal pins authorize the callback. The login endpoint is likewise unguarded — it is what issues the session — and its authority is the password plus the per-IP throttle. See [07-security.md](07-security.md#admin-oidc) for the threat model.

The session cookie remains `httpOnly`, `SameSite=Strict`, and `Secure` with the `__Host-` prefix by default. `SESSION_COOKIE_INSECURE=true` remains the explicit plain-HTTP LAN escape hatch described in [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie).

### Session lifetime and durability

Sessions live in Postgres (`admin_sessions`, `services/admin-auth/postgresSessionStore.ts`), so a redeploy, a crash, or a `bun --watch` restart no longer logs the operator out — the row is what authenticates, and a new process reads it back on the first request. The row stores a **SHA-256 hash** of the opaque session id, never the id: the cookie value is the bearer, and a database dump must not be a bag of live sessions. The CSRF token is stored as-is because the SPA reads it back on every session read and it authorizes nothing without the cookie beside it. A small per-replica read-through cache (`ADMIN_SESSION_CACHE_MAX`) keeps `authenticate()` off Postgres for sessions it has seen; the idle-window slide is written back at most once per `ADMIN_SESSION_TOUCH_INTERVAL_SECONDS` using an awaited conditional update of an existing, unexpired row. A slide never inserts. Logout fences local reads and updates and deletes the row synchronously. Other replicas revalidate within `ADMIN_SESSION_REVALIDATE_SECONDS` (60 seconds by default). Expired rows are swept by the `admin_session_purge` task.

`ADMIN_SESSION_TOUCH_INTERVAL_SECONDS` must be less than `ADMIN_SESSION_IDLE_MINUTES * 60`, including resolved defaults. Otherwise even an active session could reach its persisted idle expiry before another slide is due. Boot rejects that configuration; `0` remains valid and persists every slide.

**The defaults are thirty days on both bounds** (`ADMIN_SESSION_IDLE_MINUTES=43200`, `ADMIN_SESSION_ABSOLUTE_HOURS=720`), and that is a deliberate trade for a single-operator console behind an IdP: the previous eight-hour idle window and daily cap meant a login on every redeploy and every morning, which for one operator is friction with no compensating threat model. What the trade costs: a stolen cookie is a live credential for up to thirty days of inactivity. What still holds: the cookie is `HttpOnly`/`Secure`/`__Host-` so a script or a sibling host cannot read or plant it; logout is a real invalidation, not a client-side forget; a login always mints a fresh id and CSRF token (no fixation); the IdP's own session is untouched and can be revoked there; and both bounds are configuration — an operator who wants the old posture sets `480` and `24`. Authenticated browser activity renews the cookie Max-Age within the remaining absolute lifetime. Static bearer authentication never creates or renews a cookie.

## Break-glass access

`ADMIN_API_TOKEN` is unchanged. It authenticates `/api/admin/**` as `admin-api-token`, requires no browser or CSRF token, and is audited separately from a browser session. Keep it in the deployment's secret store and rotate it by changing the value and restarting.

A router API key (`mar_live_…`) can never authenticate the admin plane.

## Verify a deployment

1. Open `/login`. The page shows **Sign in with SSO**, a password form, or both — matching what you configured (`GET /api/admin/auth/methods` says the same).
2. With OIDC: complete the identity-provider login and confirm the console loads; confirm `GET /api/admin/auth/session` returns the email *you* signed in with, and the audit feed contains an `admin.login` event for that same address. Sign in as a second allowlisted operator and confirm both records name them and not the first entry.
3. With a local password: sign in with it and confirm the console loads; `GET /api/admin/auth/session` returns `local-admin`. A wrong password returns `401` with the same generic sentence the OIDC callback uses.
4. Confirm the fail-closed rule if you enabled the password: boot with `PUBLIC_URL` set to a non-loopback address refuses, naming `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC`.
5. Exercise `ADMIN_API_TOKEN` separately so the recovery path is proven before it is needed.

## Troubleshooting

The browser receives only “Single sign-on verification failed.” — for both paths. The kind is in the router log and in the audit feed, never in the response:

```
{"level":"warn","msg":"admin sign-in rejected at the OIDC callback","component":"admin-auth",
 "reason":"principal: sign-in email \"someone@example.com\" is not in ADMIN_OIDC_ADMIN_EMAIL", ...}
```

Match the `reason` prefix against this table:

| Diagnostic | Check |
|---|---|
| `discovery:*` | Issuer spelling, discovery reachability, and advertised PKCE S256 support. |
| `jwks` | JWKS reachability and the provider's signing keys. |
| `idtoken:wrong_issuer` | Discovery `issuer` versus `ADMIN_OIDC_ISSUER_URL`. |
| `idtoken:wrong_audience` | Client ID and the ID token's `aud`. |
| `idtoken:wrong_nonce` | A fresh browser flow; state and nonce cannot be replayed. |
| `idtoken:missing_email` | Request `email` scope and configure the provider to embed userinfo claims in the ID token. |
| `idtoken:email_unverified` | Mark the administrator's email verified at the provider. |
| `principal` | The asserted email is in no `ADMIN_OIDC_ADMIN_EMAIL` entry, an `ADMIN_OIDC_REQUIRED_CLAIMS` pair is unmet (claim missing, of the wrong shape, or a different value — the line names the claim), or `ADMIN_OIDC_ADMIN_SUBJECT` is set and `sub` does not equal it. The line names the rejected address; add it to the allowlist, or correct the typo. For a claim, confirm the IdP signs that claim into the ID token for this client and that its value's case matches. |
| `token_exchange:*` | The token endpoint refused the code exchange, or returned no `id_token`. Check the client secret and that the redirect URI byte-matches the registered one. Only the HTTP status is logged — a token-endpoint error body quotes the authorization code back. |
| `state` | Restart the flow; state is one-shot and expires after the configured OAuth-state retention window. |
| `admin.login_failed` audit rows with `method: "local"` | Password attempts are failing — `reason: "throttled"` means the per-IP lockout is doing its job. |
| Boot refuses, naming `bin/admin set-password` | No sign-in method exists: set the OIDC block, or set a local password. |
| Boot refuses, naming `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` | A local password exists and `PUBLIC_URL` is not loopback. Remove the password, unset `PUBLIC_URL`, or accept the risk explicitly. |

Never paste an ID token, authorization code, client secret, password, or callback URL containing `code`/`state` into an issue or log.

## Input and resource bounds

Configured issuer and callback URLs must be absolute HTTP(S) URLs without userinfo or fragments; the issuer also cannot contain a query. Explicit scopes must include `openid`. Local-only deployments can leave the OIDC block absent.

Password attempts reserve per-IP and global hashing capacity before asynchronous verification. `ADMIN_LOGIN_MAX_CONCURRENT` defaults to 4 and `ADMIN_LOGIN_MAX_TRACKED_IPS` to 10000. OIDC starts are throttled before allocating state, and all identity-provider reads, including response bodies, have a deadline (`ADMIN_OIDC_REQUEST_TIMEOUT_MS`, default 10000). Tokens with future issue times, missing required authorized-party claims, or a mismatching authorized party are rejected.
