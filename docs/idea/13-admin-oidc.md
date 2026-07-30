# Admin OIDC

Status: **implemented**. The admin console has one sign-in path: a generic OpenID Connect authorization-code flow with PKCE. There is no username/password fallback. `ADMIN_API_TOKEN` remains the separate break-glass credential for scripts and recovery.

The router is an OIDC relying party, not an identity provider. Any standards-compliant provider that exposes discovery metadata and signs ID tokens with RS256 can be used without code changes. Zitadel is the production-tested provider; Keycloak, Authentik, and Auth0 use the same configuration contract.

## Security boundary

This remains a single-admin, self-hosted product. OIDC replaces the admin credential; it does not add users, organizations, or RBAC.

A successful callback must satisfy every check:

1. The authorization `state` exists, is unexpired, and is consumed exactly once.
2. The code exchange uses PKCE S256 and the configured redirect URI.
3. The ID token signature verifies against the issuer's JWKS.
4. `iss`, `aud`, `exp`, `iat`, and `nonce` match the current flow.
5. The token contains `email` and `email_verified: true`.
6. The asserted email matches `ADMIN_OIDC_ADMIN_EMAIL` case-insensitively.
7. When `ADMIN_OIDC_ADMIN_SUBJECT` is set, `sub` matches it exactly.

Every rejection returns the same operator-facing message. Detailed claim failures are server-side diagnostics, never a browser-visible oracle.

## Register the client

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

## Configure the router

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
| `ADMIN_OIDC_ISSUER_URL` | yes | Exact OIDC issuer. Discovery is fetched from `/.well-known/openid-configuration`; the returned `issuer` must match. |
| `ADMIN_OIDC_CLIENT_ID` | yes | Client identifier and expected ID-token audience. |
| `ADMIN_OIDC_CLIENT_SECRET` | no | Confidential-client secret. Omit only for a public client; PKCE remains mandatory either way. |
| `ADMIN_OIDC_REDIRECT_URI` | yes | Exact callback URI registered with the provider. |
| `ADMIN_OIDC_ADMIN_EMAIL` | yes | The single email allowed to receive an admin session. Compared case-insensitively. |
| `ADMIN_OIDC_ADMIN_SUBJECT` | no | Additional exact match against `sub`. Recommended once known. |
| `ADMIN_OIDC_SCOPES` | no | Space-separated scopes. Default `openid profile email`; `openid` is mandatory. |
| `ADMIN_OIDC_CLOCK_SKEW_SECONDS` | no | Accepted clock skew for token timestamps. Default `60`; zero is refused. |

Boot fails before opening the listener when any required field is absent. `bin/setup` points directly to this document instead of generating a local admin password.

## Session and callback behavior

`GET /api/admin/auth/oidc/start` creates a ten-minute, one-shot state row containing the PKCE verifier and nonce, then redirects to the provider. `GET /api/admin/auth/oidc/callback` consumes that state before validating its binding, exchanges the code, verifies the ID token, and issues the existing bounded admin session.

The callback is intentionally unguarded: a cross-site top-level redirect cannot carry the `SameSite=Strict` session cookie. The one-shot state, nonce, PKCE verifier, and principal pins authorize the callback. See [07-security.md](07-security.md#admin-oidc) for the threat model.

The session cookie remains `httpOnly`, `SameSite=Strict`, and `Secure` with the `__Host-` prefix by default. `SESSION_COOKIE_INSECURE=true` remains the explicit plain-HTTP LAN escape hatch described in [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie).

## Break-glass access

`ADMIN_API_TOKEN` is unchanged. It authenticates `/api/admin/**` as `admin-api-token`, requires no browser or CSRF token, and is audited separately from an OIDC session. Keep it in the deployment's secret store and rotate it by changing the value and restarting.

A router API key (`mar_live_…`) can never authenticate the admin plane.

## Verify a deployment

1. Open `/login` and select **Sign in with SSO**.
2. Complete the identity-provider login and confirm the console loads.
3. Confirm `GET /api/admin/auth/session` returns the configured admin email.
4. Confirm the audit feed contains an `admin.login` event for the OIDC principal.
5. Confirm the legacy `POST /api/admin/auth/login` route returns `404` or `405`.
6. Exercise `ADMIN_API_TOKEN` separately so the recovery path is proven before it is needed.

## Troubleshooting

The browser receives only “Single sign-on verification failed.” Inspect the router log for the diagnostic kind:

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

Never paste an ID token, authorization code, client secret, or callback URL containing `code`/`state` into an issue or log.
