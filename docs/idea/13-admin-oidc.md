# Admin sign-in

Status: **implemented**. The admin console has two sign-in paths, either of which is sufficient on its own:

1. **Generic OIDC** — an authorization-code flow with PKCE against any standards-compliant provider. This is the recommended path for anything reachable by more than one machine: the sign-in guarding your console is then your identity provider's, with its MFA and its audit trail behind it.
2. **Local admin password** — an operator-set password stored as an argon2id hash in Postgres, created with `bin/admin set-password`. Off by default, intended for own-machine use, and fail-closed on a public address (see below).

`ADMIN_API_TOKEN` remains the separate break-glass credential for scripts and recovery.

Boot requires **at least one** of the two. A fresh database with no `ADMIN_OIDC_*` variables and no password row refuses to start, naming both remedies. A *partial* OIDC block (some of the four required variables set, not all) fails the same fast env validation it always did, pointing here.

The router is an OIDC relying party, not an identity provider. Any standards-compliant provider that exposes discovery metadata and signs ID tokens with RS256 can be used without code changes. Zitadel is the production-tested provider; Keycloak, Authentik, and Auth0 use the same configuration contract.

## Security boundary

This remains a single-admin, self-hosted product. Both sign-in paths mint the same bounded session for the same single principal; neither adds users, organizations, or RBAC.

A successful OIDC callback must satisfy every check:

1. The authorization `state` exists, is unexpired, and is consumed exactly once.
2. The code exchange uses PKCE S256 and the configured redirect URI.
3. The ID token signature verifies against the issuer's JWKS.
4. `iss`, `aud`, `exp`, `iat`, and `nonce` match the current flow.
5. The token contains `email` and `email_verified: true`.
6. The asserted email matches `ADMIN_OIDC_ADMIN_EMAIL` case-insensitively.
7. When `ADMIN_OIDC_ADMIN_SUBJECT` is set, `sub` matches it exactly.

Every rejection — from either path — returns the same operator-facing sentence. Detailed claim failures are server-side diagnostics, never a browser-visible oracle.

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

For the configured administrator, verify the provider records the email as verified. Prefer also setting `ADMIN_OIDC_ADMIN_SUBJECT` after the first enrollment: email is the required human-readable pin, while `sub` adds an immutable provider-specific pin.

## Configure the router for OIDC

```dotenv
ADMIN_OIDC_ISSUER_URL=https://sso.example.com
ADMIN_OIDC_CLIENT_ID=multi-ai-router
ADMIN_OIDC_CLIENT_SECRET=replace-with-client-secret
ADMIN_OIDC_REDIRECT_URI=https://router.example.com/api/admin/auth/oidc/callback
ADMIN_OIDC_ADMIN_EMAIL=admin@example.com
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
| `ADMIN_OIDC_ADMIN_EMAIL` | for OIDC | The single email allowed to receive an admin session. Compared case-insensitively. |
| `ADMIN_OIDC_ADMIN_SUBJECT` | no | Additional exact match against `sub`. Recommended once known. |
| `ADMIN_OIDC_SCOPES` | no | Space-separated scopes. Default `openid profile email`; `openid` is mandatory. |
| `ADMIN_OIDC_CLOCK_SKEW_SECONDS` | no | Accepted clock skew for token timestamps. Default `60`; zero is refused. |
| `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` | no | `true` opts out of the fail-closed loopback rule for the local password. Default `false`; boot warns every time it is on. |

The four OIDC fields are all-or-nothing: all absent means "OIDC off, local password only"; a partial block fails env validation naming what is missing. Whether *some* sign-in method exists is decided after migrations, because the local credential's existence is a database row — the refusal names both remedies and points here.

## Session and callback behavior

`GET /api/admin/auth/oidc/start` creates a ten-minute, one-shot state row containing the PKCE verifier and nonce, then redirects to the provider. `GET /api/admin/auth/oidc/callback` consumes that state before validating its binding, exchanges the code, verifies the ID token, and issues the bounded admin session. Both answer `404` when OIDC is not configured. `POST /api/admin/auth/login` verifies the password against the stored argon2id hash and issues the identical session. `GET /api/admin/auth/methods` is public and reports which paths exist (`{ "oidc": bool, "local": bool }`) — it is how the login page knows what to render.

The callback is intentionally unguarded: a cross-site top-level redirect cannot carry the `SameSite=Strict` session cookie. The one-shot state, nonce, PKCE verifier, and principal pins authorize the callback. The login endpoint is likewise unguarded — it is what issues the session — and its authority is the password plus the per-IP throttle. See [07-security.md](07-security.md#admin-oidc) for the threat model.

The session cookie remains `httpOnly`, `SameSite=Strict`, and `Secure` with the `__Host-` prefix by default. `SESSION_COOKIE_INSECURE=true` remains the explicit plain-HTTP LAN escape hatch described in [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie).

## Break-glass access

`ADMIN_API_TOKEN` is unchanged. It authenticates `/api/admin/**` as `admin-api-token`, requires no browser or CSRF token, and is audited separately from a browser session. Keep it in the deployment's secret store and rotate it by changing the value and restarting.

A router API key (`mar_live_…`) can never authenticate the admin plane.

## Verify a deployment

1. Open `/login`. The page shows **Sign in with SSO**, a password form, or both — matching what you configured (`GET /api/admin/auth/methods` says the same).
2. With OIDC: complete the identity-provider login and confirm the console loads; confirm `GET /api/admin/auth/session` returns the configured admin email, and the audit feed contains an `admin.login` event for the OIDC principal.
3. With a local password: sign in with it and confirm the console loads; `GET /api/admin/auth/session` returns `local-admin`. A wrong password returns `401` with the same generic sentence the OIDC callback uses.
4. Confirm the fail-closed rule if you enabled the password: boot with `PUBLIC_URL` set to a non-loopback address refuses, naming `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC`.
5. Exercise `ADMIN_API_TOKEN` separately so the recovery path is proven before it is needed.

## Troubleshooting

The browser receives only “Single sign-on verification failed.” — for both paths. Inspect the router log for the diagnostic kind:

| Diagnostic | Check |
|---|---|
| `discovery:*` | Issuer spelling, discovery reachability, and advertised PKCE S256 support. |
| `jwks` | JWKS reachability and the provider's signing keys. |
| `idtoken:wrong_issuer` | Discovery `issuer` versus `ADMIN_OIDC_ISSUER_URL`. |
| `idtoken:wrong_audience` | Client ID and the ID token's `aud`. |
| `idtoken:wrong_nonce` | A fresh browser flow; state and nonce cannot be replayed. |
| `idtoken:missing_email` | Request `email` scope and configure the provider to embed userinfo claims in the ID token. |
| `idtoken:email_unverified` | Mark the administrator's email verified at the provider. |
| `principal` | Configured admin email and optional subject versus the provider claims. |
| `state` | Restart the flow; state is one-shot and expires after the configured OAuth-state retention window. |
| `admin.login_failed` audit rows with `method: "local"` | Password attempts are failing — `reason: "throttled"` means the per-IP lockout is doing its job. |
| Boot refuses, naming `bin/admin set-password` | No sign-in method exists: set the four OIDC variables, or set a local password. |
| Boot refuses, naming `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` | A local password exists and `PUBLIC_URL` is not loopback. Remove the password, unset `PUBLIC_URL`, or accept the risk explicitly. |

Never paste an ID token, authorization code, client secret, password, or callback URL containing `code`/`state` into an issue or log.
