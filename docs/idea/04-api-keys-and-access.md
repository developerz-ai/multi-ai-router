# API Keys and Access

Status: **implemented**, except where a row says otherwise — the two planes, admin auth with CSRF
and OIDC callback throttling, key mint/reveal/revoke, both header styles, and scope enforced as an
intersection all work, as does `GET /api/admin/usage`. Per-key rate limits are enforced in memory,
per replica. `/api/admin/settings` reads the deployment's configuration and edits the price-override
table; the retention windows and the log level are environment variables and are shown, not
editable. Connect/reconnect is built for both logins — the
`claude` CLI's own for Claude subscriptions, and the authorization-code flow the router drives for
the reverse-engineered OAuth providers, including its redirect callback.

## Two planes

The router has exactly two credential spaces. They never overlap.

| Plane | Who | Credential | Surface | Protects |
|---|---|---|---|---|
| **Admin plane** | the single operator, through a browser | session cookie, issued at login | `/api/admin/**` + the SPA | configuration: accounts, pools, keys, settings |
| **Admin plane, no browser** | scripts, CI, agents | `ADMIN_API_TOKEN` bearer | `/api/admin/**` | the same configuration, driven programmatically |
| **Data plane** | clients and agents (Claude Code, Codex CLI, Cline, …) | router API key `mar_live_…` | `/v1/**` | inference traffic |

A router API key **cannot** reach the admin plane, ever — not with a scope, not with a flag, not
under any configuration. A session cookie is not accepted on `/v1/**`. Separate credential
spaces, separate middleware, separate failure modes.

The middle row is two credentials into **one** plane, not a third plane: same routes, same
services, same audit trail. Only how the caller proves who it is differs.

### Driving the admin API without a browser

The admin plane has always been an ordinary REST API — what it had no way to accept was a caller
with no cookie jar. `ADMIN_API_TOKEN` is that credential, and it is the same answer `METRICS_TOKEN`
gives Prometheus: one static bearer the operator sets, compared in constant time.

```bash
export MAR=https://router.example.com
export TOK=$ADMIN_API_TOKEN

curl -s $MAR/api/admin/auth/session -H "Authorization: Bearer $TOK"
# {"username":"admin-api-token","csrfToken":"","issuedAt":"…","expiresAt":null}

curl -s -X POST $MAR/api/admin/accounts -H "Authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"label":"glm-prod","provider":"zai","credential":"…"}'
```

Every route in [Admin API route groups](#admin-api-route-groups) accepts it, reads and writes
alike.

| Rule | Why |
|---|---|
| **Unset by default** | No token means the plane is browser-only, exactly as it was. This adds a credential; it does not enable one. |
| **Refused under 32 characters, at boot** | Every browser sign-in is IP-throttled before OIDC state or code exchange. A static bearer is not: it is checked and answered on every request, forever, at whatever rate the network allows. Length is the only thing bounding that budget. |
| **Refused if it begins `mar_live_`, at boot** | The guard rejects that prefix as a data-plane credential *before* any comparison, so such a token would authenticate nothing while looking correct. Refusing it at boot turns a silent dead end into a message naming the variable. |
| **No CSRF token required** | CSRF defends against a browser attaching *ambient* authority to a request the user did not intend. A bearer token is not ambient — no browser sends it cross-site on its own — and demanding one would be unsatisfiable anyway, since minting a CSRF token requires the login this credential exists to avoid. |
| **Never expires; `POST /logout` refuses it** | It is a variable, not a session. Answering `logged_out` would report a revocation that did not happen and leave the caller holding a credential it believes it surrendered. Rotation is: change the value, restart. |
| **Audited as `admin-api-token`** | Not as the OIDC principal. An operator reading the audit feed has to be able to tell a console login from a script, because revoking the two is a different action. |

## Admin authentication

A single admin principal. It is asserted either by an OpenID Connect provider or by the optional local admin password — an argon2id hash in Postgres set by `bin/admin set-password`, off by default, and fail-closed on a non-loopback `PUBLIC_URL`. No router user table either way. The full relying-party contract, the password door, and provider setup live in [13-admin-oidc.md](13-admin-oidc.md).

| Variable | Meaning |
|---|---|
| `ADMIN_OIDC_ISSUER_URL` | Exact issuer used for discovery and the `iss` check. |
| `ADMIN_OIDC_CLIENT_ID` | OIDC client and expected ID-token audience. |
| `ADMIN_OIDC_CLIENT_SECRET` | Confidential-client secret; optional for public clients. PKCE remains mandatory. |
| `ADMIN_OIDC_REDIRECT_URI` | Exact registered callback URI. |
| `ADMIN_OIDC_ADMIN_EMAIL` | Required. Comma-separated; a verified `email` claim in the ID token must match one entry, case-insensitively. |
| `ADMIN_OIDC_ADMIN_SUBJECT` | Optional stricter exact match against `sub`. |

The only password-shaped credential is the optional local admin password above; the router keeps no TOTP secret. TOTP, passkeys, MFA policy, enrollment, and account recovery belong to the configured IdP — which is exactly why the password door, having no second factor, is loopback-only by default. Adding a second factor *after* the router-issued session would be a separate design decision, not a deferred field.

`GET /api/admin/auth/oidc/start` is IP-throttled before it creates state. The callback consumes one-shot state, verifies PKCE, nonce, signature, standard claims, verified email, and the configured principal pins, then issues the same bounded session described below. Every callback rejection uses one generic response. Detailed diagnostics stay server-side.

`ADMIN_API_TOKEN` remains the independent break-glass path. It is not a browser session and is audited as `admin-api-token`.

### Session cookie

| Property | Value | Why |
|---|---|---|
| `httpOnly` | always | no script can read it |
| `SameSite` | `Strict` | no cross-site submission carries it |
| `Path` | `/` | SPA and API share an origin |
| `Secure` | default | HTTPS is assumed in front (reverse proxy) |
| `__Host-` prefix | default | host-only, `Path=/`, `Secure` — enforced by the *browser*. What stops a sibling subdomain planting a session cookie on this origin |
| Lifetime | sliding idle window (`ADMIN_SESSION_IDLE_MINUTES`, default 43200 — 30 d) under a hard absolute cap (`ADMIN_SESSION_ABSOLUTE_HOURS`, default 720 — 30 d); the session row lives in Postgres and survives a redeploy ([13-admin-oidc.md](13-admin-oidc.md#session-lifetime-and-durability)) | Sliding alone means a stolen cookie is renewable forever by the thief; the cap turns "forever" into a bounded window. A session dies at whichever bound comes first |
| `SESSION_COOKIE_INSECURE` | `false` | The escape hatch. Set `true` to drop `Secure` **and** `__Host-`, and nothing else |

**Why the escape hatch exists.** A self-hosted router reached at `http://192.168.1.50:8080` — a
LAN install with no proxy, which is a normal way this is run — is *unusable* with the hardened
cookie: a browser silently discards a `Secure` cookie delivered over `http://`, so the OIDC callback succeeds and every request after it is `401`. `SESSION_COOKIE_INSECURE=true`
([09-deployment.md](09-deployment.md#environment-reference)) is the one supported answer.

**And the router says so.** This is the only misconfiguration on the admin plane with no HTTP
answer available: the callback is legitimate and the `401` lands on the *next* request, which
did nothing wrong. The server is the only party that sees both halves, so the OIDC callback emits a
`warn` naming `SESSION_COOKIE_INSECURE` whenever it sets a `Secure` cookie on a request that
arrived over plain `http://`. `X-Forwarded-Proto: https` suppresses it, **whether or not
`TRUST_PROXY` is set** — the asymmetry with the login throttle is deliberate: a forged
`X-Forwarded-For` earns a fresh throttle bucket, while a forged `X-Forwarded-Proto` earns only the
silencing of an advisory line, and reading it under `TRUST_PROXY` alone would warn on every
correctly-proxied install whose operator left that default off. The line is a log line and not a
field in the response body, because the wire shape of `/login` is a contract with the console.

The two attributes come off **together**, because they cannot come off separately: the `__Host-`
prefix is honored only on a cookie that also carries `Secure`. Everything that does not depend on
the transport stays on — `httpOnly`, `SameSite=Strict`, `Path=/`, the server-side session record,
and the CSRF token on every mutation. What is given up is confidentiality on the wire and the
sibling-host injection defence, which is why it defaults to off and the router logs a `warn`
naming the risk on every boot while it is on.

Flipping the flag renames the cookie, so live sessions do not survive the change — the operator
logs in again, which is the honest outcome rather than a session silently downgraded.

### CSRF and throttling

- A CSRF token is required on every **mutating** admin request (`POST`/`PATCH`/`DELETE`).
  `SameSite=Strict` is the first line; the token is the second, because one is a browser
  behavior and the other is an application invariant.
- **OIDC start/callback throttling** on the admin plane is keyed by client IP. `GET /oidc/start`
  is charged before state is created, and the callback is charged before code exchange. Tunable, not
  constant — `ADMIN_LOGIN_MAX_ATTEMPTS`, `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES`,
  `ADMIN_LOGIN_LOCKOUT_MINUTES` ([09-deployment.md](09-deployment.md#environment-reference)).
  The key is only as good as the IP, which is why `TRUST_PROXY` defaults to off: an unvetted
  `X-Forwarded-For` is a throttle bypass.
- OIDC failures are indistinguishable to the caller. The server log carries a bounded diagnostic kind;
  no claim, token, code, or state value is returned.

## Router API keys

### Format

```
mar_live_<random>
```

| Part | Purpose |
|---|---|
| `mar_live_` | Fixed, greppable prefix. Makes a leaked key obvious in a log, a diff, or a secret scanner. |
| `<random>` | Cryptographically secure random, URL-safe. **At least 160 bits** of entropy — brute force is not a threat model, accidental collision is not a possibility. |

Every key has a required, human-chosen **name**: `sebastian-laptop`, `ci-agent-3`,
`cline-desktop`. The name is how the operator finds the key later, and how usage is attributed
in the dashboard.

### Key visibility — encrypted, not hashed

Router keys are **stored encrypted at rest and are retrievable at any time**. The admin UI can
decrypt and re-display a key's full value on demand, as many times as the operator wants.

**Why not hashed:** an operator running a fleet of agents has to be able to look a key up later.
A hash-only store makes "which key did `ci-agent-3` get?" unanswerable, and forces a rotation —
plus a redeploy of whatever holds it — every time someone loses one. That is a bad trade for a
self-hosted, single-admin tool where the operator already holds every upstream credential in the
same database.

| Property | Choice |
|---|---|
| Storage | AES-256-GCM, the **same** `ENCRYPTION_KEY` that protects upstream credentials |
| Retrievable | yes — decrypt-and-copy from the admin UI at any time, no rotation needed |
| Hashed | no |
| Shown once | no |
| Returned by the data plane | never — only the admin plane, only to an authenticated session |
| Logs | redacted always; the redactor is tested |

**The trade-off, stated plainly:** `ENCRYPTION_KEY` now becomes the single secret protecting
*both* your upstream credentials *and* every router key. Losing it loses everything; leaking it
leaks everything. It is 32 bytes of base64, boot fails loudly if it is missing or short, and it
belongs in a secret store rather than a committed `.env`. See [07-security.md](07-security.md).

### Verification path

Presented key → **indexed lookup by display prefix** → decrypt → **constant-time compare** →
check `revoked`, `expires_at` → resolve scope → **charge the rate-limit window**.

The display prefix is a short leading slice of the key, stored in clear and indexed. It turns
verification into one row fetch and one decrypt instead of a table scan, and it is also what the
UI shows in lists (`mar_live_8f3c…`). It is too short to be useful to an attacker on its own.

The rate-limit window is charged last, and by the dispatcher rather than the verifier: a verified
key is **cached**, so a limiter living inside verification would only ever see the cache misses.

### Accepted in both dialects

| Header | Style | Sent by |
|---|---|---|
| `Authorization: Bearer mar_live_…` | OpenAI | Codex CLI, Aider, OpenAI SDKs, most agents |
| `x-api-key: mar_live_…` | Anthropic | Claude Code, Anthropic SDKs |

Both are accepted on every data-plane route. **One key works for OpenAI-style and
Anthropic-style clients** — the operator never has to know which dialect a tool speaks, and a
single key can be pasted into any of them. If both headers are present and disagree, the
request is rejected rather than silently preferring one.

### Key scope

Every key carries a **scope** — the set of Accounts it may reach — in one of three forms:
`all`, one or more Pools, or an explicit Account list. It declares *what a key may use*, never
*which account it gets*; the account is the router's choice. Full detail below in
[Key scope — full vs. limited](#key-scope--full-vs-limited).

### Per-key controls

| Control | Type | Notes |
|---|---|---|
| `name` | string, required | human-chosen; unique per deployment |
| Scope | `all` / pools / accounts | see above |
| Rate limit | requests per window | Enforced as an **exact sliding window** over accepted requests, in memory, before the request body is read — a refusal must cost less than the request it refuses. Over the ceiling → `429` `key_rate_limited` + `Retry-After`, and never `quota_exhausted`: one key spending its allowance is not the pool running out. **Per replica**, deliberately: a shared counter would put a round trip on the request path, so two replicas admit up to twice the ceiling |
| Expiry | timestamp, optional | a key past expiry is rejected exactly like a revoked one |
| Revoked | flag | one-way |

Per-key **spend budgets** are **DEFERRED**.

### Lifecycle

```
created (named)  ──▶  active  ──▶  revoked  ──▶  purged
                      │
                      └─ value viewable and copyable at any time
```

| Transition | Semantics |
|---|---|
| created → active | Immediate. The key works on the next request. |
| active | The value can be decrypted and re-copied from the admin UI whenever the operator needs it. Editing name, limits, or scope never changes the value — **Edit** on any key row is the console's door to `PATCH /api/admin/keys/:id`, so a wrong scope or a missing ceiling is fixed in place rather than by minting a replacement and re-issuing a value to every client holding the old one. A rate limit is not a mint-time decision: both halves are set, changed, and removed (`rateLimit: null`) from that same form. |
| active → revoked | **Immediate** for new requests — the next one gets `401`. **In-flight requests finish**: the router does not tear down a stream mid-response, because a half-written response is worse than one extra completed call. Revocation is one-way; a revoked key is never reactivated. |
| revoked → purged | 30 days after revocation (configurable), so historical usage stays joinable for a while. See [09-deployment.md](09-deployment.md). |

Every mint, edit, and revocation writes an `AuditEvent`. Audit events never contain key
material. A **key reveal** in the admin UI is itself an audited read.

#### Reveal is `POST /api/admin/keys/:id/reveal`, not a `GET`

Revealing a key is semantically a read and is audited as one, but it is **the only endpoint in the
system that returns a live credential**, so it goes through the mutating-method path and carries a
CSRF token like every other console action.

| Reason | Detail |
|---|---|
| A `GET` that returns a secret is one `<img src="…/reveal">` away from being interesting | Cross-site requests cannot carry the CSRF token, and `SameSite=Strict` plus a required token is two independent barriers rather than one |
| Secrets do not belong in a URL | Referrers, proxy logs, browser history, and shell history all record a path; none of them records a `POST` body |
| The cost is nothing | The SPA already sends the token on every other mutation, so the stricter verb is a header it was sending anyway |

There is still no shown-once flow and no rotate endpoint — the verb is about *how* the value is
fetched, never about *whether* it can be fetched again. It always can.

#### The value is shown with somewhere to put it

Both the mint and the reveal render the key inside a **Point your tool at it** panel: one tab per
client (Claude Code, Cursor, Codex CLI, Aider, the OpenAI SDKs, `curl`), each block pre-filled with
this deployment's base URL — `PUBLIC_URL` when the operator set one, otherwise the console's own
origin — and the key's real value. A snippet containing `YOUR_KEY_HERE` is a snippet that gets
pasted containing `YOUR_KEY_HERE`.

This holds for **every** surface that mints, not just the Keys screen. A key can also be minted
from the Overview screen's first-run walk (add an account → pool it → mint a key), and that walk
shows the same dialog rather than a reduced version of it. The operator arriving there is the one
who has never seen this router before — the one who most needs to be told which clients want the
`/v1` suffix — so putting the newcomer on a lesser block and the experienced operator on the good
one would be exactly backwards.

The suffix rule is the reason this is generated rather than written out six times: an
OpenAI-dialect client appends `/chat/completions` to what it is given and so needs `/v1` already
there, while an Anthropic-dialect one appends `/v1/messages` itself and must be handed the bare
origin. One helper owns that (`apps/web/src/lib/client-snippets.ts`), so the two cannot disagree.

#### …and the console forgets it when that panel closes

Retrievable is not the same as retained. Closing the dialog drops the plaintext from the console
entirely: the signal feeding the dialog is cleared, and the mutation that produced the value — the
mint or the reveal — is reset so TanStack's *mutation* cache stops holding its result too. That
second half is not automatic. A mutation result lives in that cache for `gcTime` (five minutes by
default) after its last observer detaches, and a mounted screen never detaches on its own, so the
two reveal-carrying mutations declare `gcTime: 0` **and** the screen resets them on close. Either
one alone leaves a live credential readable in the tab.

This costs nothing, because the value was never the scarce thing: reading it again is one more
audited `POST`, which is the intended price and the reason there is no shown-once flow to begin
with.

### What a key cannot do

| Cannot | Because |
|---|---|
| Reach any admin route | Separate credential space. No scope grants it. |
| See, list, or add Accounts | Configuration is admin-plane only. |
| See an upstream credential | No endpoint returns one, on either plane. |
| Choose its account | The client picks the model; the router picks the account. |
| Reveal another key | Key reveal is an admin-plane action behind the session cookie. |
| Exceed its scope | Filtering happens before policy; an out-of-scope account is never a candidate. |

## Key scope — full vs. limited

Scope is the access-control half of the product: pooling is what makes accounts *shareable*,
scope is what makes them *shareable safely*. Three forms, all first-class — none is a degraded
version of another.

| Scope | Meaning | Typical use |
|---|---|---|
| `all` | Every `active` Account is a candidate. **Full scope.** | The operator's own laptop key — the trusted teammate. |
| *pools* | Bound to one or more Pools. Candidates are the union, in the listed order, and each pool's own routing policy applies within that pool. | **The normal case.** One agent, one budget; or a primary pool with an overflow pool behind it. |
| *accounts* | Pinned to an explicit list of Accounts, **ignoring pool membership entirely**. | "This CI agent may only ever burn the cheap OpenRouter key." "This contractor's key touches exactly one sub." |

### How scope is enforced

Scope is applied **at selection time**, not at mint time — so editing a pool, adding an account,
or disabling one takes effect on the very next request, with no key change and no re-mint.

| Rule | Statement |
|---|---|
| **Intersection, always** | The candidate set is the intersection of the pool's members and the key's scope. Both must admit an Account for it to be a candidate. |
| **Never silently widened** | A key can never reach an Account outside its scope — not because the routing policy would prefer it, not because everything in scope is cooling down or exhausted, not because a pool gained a member. No setting relaxes this. |
| **Empty set fails loudly** | A request whose scope resolves to zero candidates fails with a clear error naming the actual reason — "key `ci-agent-3` is scoped to 1 account, which is out of credits" — never a fallback to a broader set. Status code follows the cause; see [05-routing-and-failover.md](05-routing-and-failover.md). |
| **Scope precedes policy** | Filtering runs before the policy, so a policy never sees an out-of-scope account to prefer in the first place. |

An out-of-scope Account is not "deprioritized" — as far as that key is concerned it does not
exist, including in `GET /v1/models`, which lists only the models reachable within the presenting
key's scope. What each in-scope Account contributes to that listing is its `supportedModels` seen
through its alias map — see [06-protocol-translation.md](06-protocol-translation.md#model-names).

## Admin API route groups

Paths and purpose only. Handler detail belongs in [01-architecture.md](01-architecture.md).

| Group | Purpose | Built |
|---|---|---|
| `/api/admin/auth/**` | login, logout, session probe, CSRF token | yes |
| `/api/admin/accounts/**` | upstream account CRUD, health, re-check, test, model discovery, connect/reconnect | yes — CRUD + disable + re-check + test + `POST /:id/models/discover`, and connect/reconnect for both flows (the `claude` CLI's login, and the authorization-code flow the router drives) |
| `/api/admin/pools/**` | pool CRUD, membership, policy, weights, priority order, overflow account | yes |
| `/api/admin/keys/**` | list, create, reveal, edit limits and bindings, revoke | yes |
| `/api/admin/providers` | the static provider registry, so the console's account form is never a second copy of it | yes |
| `GET /api/admin/usage` | totals, series and breakdowns by key, account, pool, model, over a window | yes |
| `GET`/`PATCH` `/api/admin/settings` | the running build's `version`; retention knobs, log level, janitor cadence and the configured `PUBLIC_URL` (or null) read from the environment; the shipped price table with the date it was verified (`prices.shippedAsOf`) so an override is edited against the rows it replaces, and the overrides themselves read and written | yes — the `PATCH` takes the price overrides as one complete set, so the table is never half-applied, and the warm price book is refreshed before the response is written |
| `GET /api/admin/tasks` | the latest run of every scheduled task, and whether it is overdue | yes |
| `GET /api/admin/audit` | the append-only admin-plane audit feed, newest first | yes |

Every group above accepts either admin credential — the console's session cookie, or the
`ADMIN_API_TOKEN` bearer described in [Driving the admin API without a
browser](#driving-the-admin-api-without-a-browser). The one route that distinguishes them is
`POST /api/admin/auth/logout`, which refuses the token because there is no session to end.

The connect flow under `/api/admin/accounts` is four calls, all guarded like the rest of the plane:
`POST /:id/connect` answers with an authorization URL, `POST /:id/connect/complete` takes back the
value the authorization page left behind, `DELETE /:id/connect` abandons what is pending rather than
leaving a subprocess — or a redeemable `state` — to its TTL, and `POST /:id/reconnect` is the same
start against the same row: id, config directory, pool membership, and usage history all survive,
and only the audit kind differs (`account.reauthorized` rather than `account.connected`).

Every account read (`GET /api/admin/accounts`, `GET /api/admin/accounts/:id`) carries a
`credential` field beside `availability`:

```json
"credential": {
  "expiresAt": "2026-10-03T09:30:00.000Z",
  "subscriptionType": "max",
  "rateLimitTier": "default_claude_max_20x",
  "present": true
}
```

It is **metadata about a Claude subscription's login, never the login itself**
([11-anthropic-agent-sdk.md §3](11-anthropic-agent-sdk.md)): `expiresAt` is when the refresh token
— and so the login — dies, read from the Account's own `CLAUDE_CONFIG_DIR` so the console can warn
before it does; `subscriptionType` and `rateLimitTier` are the plan as the CLI recorded them;
`present` is whether the file still holds tokens at all. `present: false` is a login that is already
dead or never happened, and a read that finds it against an `active` row parks the row
`needs_reauth` through the same conditional status write the auth probe uses, audited as
`account.updated`. The field is `null` for every provider that holds no config directory, and also
`null` when the file could not be read — *unknown* is not *dead*, so nothing is parked then. It is
absent on a write. The reader picks exactly those fields and drops the tokens before anything else
sees the parsed file; there is no field on the response that could hold one. Reads are cached per
account for `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS`.

**The same four calls serve both logins.** Which one an Account takes is read from the provider
registry, not passed by the caller, so the console has no table of provider-to-endpoint: a Claude
subscription drives the `claude` CLI ([11-anthropic-agent-sdk.md §3.1](11-anthropic-agent-sdk.md)),
every other connectable provider runs the authorization-code flow in
[03-providers.md](03-providers.md). That flow adds one route outside this group and outside the
guard — `GET /admin/accounts/oauth/callback`, the redirect capture, authorized by its one-shot
`state` and reasoned about in [07-security.md](07-security.md). No response, log, or error on any of
them carries an authorization code, a `state`, or a token.

Data-plane routes (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`,
`/v1/responses`, `/v1/embeddings`, `/v1/models`) are in
[06-protocol-translation.md](06-protocol-translation.md). Operational endpoints (`/healthz`,
`/readyz`, `/metrics`) are unauthenticated liveness surfaces and are covered in
[08-observability.md](08-observability.md).

## Read next

| Doc | Covers |
|---|---|
| [02-domain-model.md](02-domain-model.md) | `ApiKey` fields, relations, state machine |
| [05-routing-and-failover.md](05-routing-and-failover.md) | What the key's scope feeds into — filtering, policies, failover |
| [07-security.md](07-security.md) | Encryption at rest, redaction, rate limits, threat framing |
| [08-observability.md](08-observability.md) | Per-key usage, spend, error rate |
