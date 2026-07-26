# Security

Status: **implemented** — AES-256-GCM at rest, the tested log redactor, plane separation, admin
session + CSRF, argon2id, login throttling, per-key rate limiting, and a `METRICS_TOKEN` on
`/metrics`. **Not built:** per-IP request rate limiting. Deployment-side settings live in
[09-deployment.md](09-deployment.md); key semantics in
[04-api-keys-and-access.md](04-api-keys-and-access.md).

The router moves your own accounts through your own server. Claude subscriptions go through the
first-party Claude Agent SDK — documented calls, no token extraction, no forged requests
([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)); that is a deliberate account-safety
decision. The remaining subscription OAuth flows (ChatGPT/Codex) are reverse-engineered from the
official clients and can break when a provider changes them. Check your providers' terms for shared
and programmatic access.

## Threat model

| Actor | What they might try | Mitigation |
|---|---|---|
| **Client key holder** (a developer, an agent) | Use a key beyond its pools; enumerate other keys or accounts; read an upstream credential | Keys are bound to pools; the data plane exposes no admin routes; no endpoint returns a credential; `GET /v1/models` and `GET /v1/models/:id` are scoped to the key's reachable accounts — an out-of-scope id renders the same `404` as one that does not exist anywhere, never a distinguishable "exists but not yours"; per-key rate limit and body cap |
| **Any router key holder, against the Agent-SDK path** | Induce the model to call a host-executing built-in tool (`bash`, `read`, `write`, `edit`, `glob`, `grep`) and run commands on the router host — reading `ENCRYPTION_KEY` and the Postgres credentials out of the environment, and every Account's `CLAUDE_CONFIG_DIR` off the volume | The SDK is invoked in **passthrough-only tool mode**: host-executing built-ins are disabled by an **explicit allowlist naming them**, and tool calls are forwarded to the client to execute. See [Tool execution on the Agent-SDK path](#tool-execution-on-the-agent-sdk-path) — this is the highest-severity item in this document |
| **Compromised agent** (its key is stolen) | Burn subscription quota; exfiltrate the upstream credential it is using | Revoke that one key — no upstream credential rotates. The agent never holds one: credentials exist only inside the driver's outbound request, or inside the SDK subprocess's own config directory. Per-key rate limits bound the burn |
| **Read access to the Postgres database** (dump, replica, stolen volume) | Lift upstream tokens and router keys | Every credential column and every key value is AES-256-GCM ciphertext. The key is `ENCRYPTION_KEY` from the environment, never in the database, never in a dump |
| **Read access to the `CLAUDE_CONFIG_DIR` volume** | Lift live Claude subscription credentials | This is the one credential store the database does *not* hold. It is secret material: restricted file mode, non-root owner, backed up and permissioned like the DB dump. See below |
| **Read access to logs** | Harvest secrets from request/error output | Redaction is on by default and is a tested unit. Bodies are not logged. No credential appears in any error returned to a client |
| **Network attacker** | Intercept keys or tokens in flight; forge admin requests | HTTPS assumed in front; `Secure` + `httpOnly` + `SameSite=Strict` cookies; CSRF token on every mutating admin request; upstream calls are TLS to pinned hosts |
| **Operator** (you) | Mistakes: leaking `ENCRYPTION_KEY`, exposing the admin plane, losing the volume | Boot-time validation with loud failure; hardening checklist below; audit events for every admin-plane mutation |

## Tool execution on the Agent-SDK path

**The Claude Agent SDK executes tools on the machine it runs on, and that machine is the router.**
Its built-ins — `bash`, `read`, `write`, `edit`, `glob`, `grep` and the rest — are real operations on
the host filesystem and shell, not model output. Left reachable, they are **arbitrary command
execution on the router host for anyone holding any router key**: `ENCRYPTION_KEY` and the Postgres
credentials out of the process environment, the database behind them, and every Account's
`CLAUDE_CONFIG_DIR` off the volume. No admin credential, no network position, and no other bug is
required — one prompt that gets the model to call `bash` is the whole compromise.
[Meridian](https://github.com/rynfar/meridian) ships host tool execution because it is a single-user
local proxy, where running commands on the user's own machine is the feature. For a multi-tenant
router it is remote code execution, and the two situations must not be confused
([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §7).

| Rule | |
|---|---|
| Mode | **Passthrough-only.** The SDK never executes a tool on our behalf, in any configuration, for any Account, for any key |
| How built-ins are disabled | An **explicit allowlist that names the tools permitted to run** — never a blocklist, never a default, never "we don't pass tools so it won't". A blocklist fails open the day the SDK ships a new built-in; a default is not a decision. The allowlist is one reviewed constant, and adding a name to it is a security change. It lives in `providers/claude-sdk/allowlist.ts`, is **empty** today because passthrough is the only supported mode, and is applied twice in `options.ts`: as `allowedTools`, and as a deny-by-default `canUseTool` gate. `permissionMode: "dontAsk"` closes the third path — a call that reaches neither is denied rather than parked on a prompt nobody is there to answer |
| Where tools run | On the **client**. Captured `tool_use` calls are forwarded to the caller exactly as on the HTTP path, and the caller executes them. This is what a router should do regardless of security: the client is the thing that owns the user's filesystem, working directory, and consent |
| How the client's own tools are offered | Registered on an **in-process MCP server whose handlers refuse and do nothing** (`providers/claude-sdk/tools/`). The registration is a *declaration* surface — it exists so the model emits a well-formed `tool_use` — and it reaches `mcpServers`, never `allowedTools`. A `PreToolUse` hook denies and records every call before the SDK dispatches it; `canUseTool` denies the same names independently, because a hook's deny bypasses it and must therefore add to that gate rather than replace it. The SDK's *internal MCP* execution mode, where the in-process server really runs `bash`/`read`/`write` on this host, is disqualified permanently, not deferred |
| Anthropic server tools | Not reachable either — the SDK cannot emit `server_tool_use`; requests asking for them are rejected `400` naming the field |
| Regression gate | A test asserts that a request attempting to invoke a host-executing tool is **rejected**. It is a **security regression gate, not a nicety**: it fails the build, and it is not skipped, quarantined, or relaxed to make an unrelated change pass |

### Subprocess isolation — `settingSources: []`

The SDK subprocess is launched with `settingSources: []` **explicitly set**. Omitted, the CLI loads
the host's user, project, and local settings and pulls the **router host's own `CLAUDE.md`** into the
system prompt — ambient configuration from our machine, or from one tenant's context, entering
another key holder's request. That is a cross-tenant leak, not untidiness. It reads like dead code
because its effect is an absence; it is an isolation guarantee and must not be deleted as cleanup.
Same class as stripping inherited `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
from the subprocess environment, which also prevents it from looping back through our own router.

## Secrets at rest

| | |
|---|---|
| Algorithm | AES-256-GCM, unique random nonce per record, authenticated |
| Key source | `ENCRYPTION_KEY` — 32 bytes, base64-encoded, from the environment only |
| Encrypted (in Postgres) | Upstream credentials (API keys, access tokens, **refresh tokens**) **and** router API key values |
| Not encrypted | Labels, model alias maps, pool membership, usage records, audit events, key display prefixes |
| Outside the database | The per-Account `CLAUDE_CONFIG_DIR` volume, which holds live Claude subscription credentials in the SDK's own format. We do not encrypt or manage it — we permission and back it up as the secret it is |
| Boot | Zod-validated at startup. Missing, malformed, or short → the process exits non-zero naming the variable. Never generated on the fly, never defaulted |

**The trade-off, stated plainly:** because router keys are encrypted rather than hashed (see below),
`ENCRYPTION_KEY` protects both halves of the system — the credentials going out *and* the keys coming
in. **It is the single most important secret in the deployment.** A database dump alone is not a
compromise; a database dump *plus* `ENCRYPTION_KEY` is a total one. Store it outside the database and
its backups, keep it out of the compose file if your environment offers a secret store, and treat
losing it as losing every credential in the router.

**Claude subscriptions hold no bearer token here — deliberately.** For a Claude Max/Pro Account the
router never mints, stores, or injects a subscription token: the Agent SDK subprocess authenticates
from that Account's own `CLAUDE_CONFIG_DIR`, and credential refresh happens inside that directory.
The threat model changes shape rather than disappearing — there is no token column to leak and no
forged request to get an account banned, but the config-directory volume becomes live credential
material with the same handling requirements as the database.

Envelope format — every ciphertext record carries its own metadata. Five dot-separated segments,
unpadded base64url (`.` never occurs in base64url, so the split is unambiguous):

```
v1.<keyId>.<nonce>.<authTag>.<ciphertext>
```

Stored in one `text` column. An earlier draft of this doc specified a JSON object with an `alg`
field; the implementation is the compact string above and it is what the code does.

- **The key id is present from day one** even though only one key exists. **Key rotation is
  `DEFERRED`** — but the envelope must never be simplified away, because rotation without a key id
  means re-encrypting blind.
- **`v1.<keyId>` is bound as the GCM additional authenticated data.** A record therefore cannot be
  re-labelled with a different version or key id and still verify.
- **There is deliberately no `alg` field.** The version tag already pins the algorithm, and a
  caller-selectable algorithm is a downgrade vector.
- An unknown version or key id is **refused before decryption is attempted**, rather than tried
  against the one key we hold.
- Segment shapes are validated (and nonce/tag byte lengths checked) before any bytes reach the
  cipher, so malformed input fails as a `CredentialDecryptError` rather than inside OpenSSL.

## Secrets in transit

| Concern | Rule |
|---|---|
| Front door | HTTPS terminated by a reverse proxy in front. The container speaks plain HTTP on its own port and is not meant to be published directly |
| `TRUST_PROXY` | When set, `X-Forwarded-For` / `X-Forwarded-Proto` are honored for client IP (rate limiting, throttling, audit) and scheme. Off by default — an untrusted forwarded header is a rate-limit bypass |
| Cookies | `httpOnly` + `SameSite=Strict` always; `Secure` + `__Host-` by default, dropped together only under `SESSION_COOKIE_INSECURE` for a plain-HTTP LAN install (warned at boot — see [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie)). No cookie on data-plane routes |
| Upstream | TLS to the pinned base URLs in [03-providers.md](03-providers.md). No plaintext upstream, no proxy-through of client-supplied upstream URLs |

## Router API keys

| Property | Decision |
|---|---|
| Name | Required, human-chosen ("sebastian-laptop", "ci-agent-3"). A key you cannot name is a key you will not dare revoke |
| Format | `mar_live_` + a random suffix from a CSPRNG, ≥ 128 bits of entropy, printable/copy-safe |
| Storage | AES-256-GCM ciphertext, plus a short **display prefix** stored in clear and indexed |
| Verification | Prefix lookup selects one row → decrypt → constant-time compare. One decrypt, not a table scan, not a linear sweep |
| Accepted as | `Authorization: Bearer mar_live_…` and `x-api-key: mar_live_…` |
| Retrievable | Yes — the admin can view and copy a key again at any time |

**Named and retrievable, not hashed — deliberate, and here is what it costs.** An operator running a
fleet of agents needs to look a key up later, by name, without rotating it and reconfiguring every
agent; the admin can view and copy any key at any time. That convenience means the router can
reconstruct plaintext keys, so the strength of every key reduces to the strength of `ENCRYPTION_KEY`
— a hash-only design would survive a database leak even with that key compromised. **This is the
decision that makes `ENCRYPTION_KEY` the single most important secret in the deployment: it now
protects the upstream credentials going out and the router keys coming in.** We take the trade
knowingly and pay for it with encryption at rest for key values, an audit event on every view
(`key.viewed`), per-key rate limits, and instant revocation. The UI still shows a newly minted key
inline with a copy button — retrieval is the recovery path, not the normal one.

## Admin plane

| Element | Rule |
|---|---|
| Identity | A single admin, from the environment. No user table in v1 |
| Credentials | `ADMIN_USERNAME` + `ADMIN_PASSWORD` (plaintext in env, hashed with argon2id at boot, never persisted in plaintext), or `ADMIN_PASSWORD_HASH` (pre-computed argon2id). **`ADMIN_PASSWORD_HASH` takes precedence when both are set.** Exactly one form must be present or boot fails |
| Hashing | argon2id, with parameters pinned in one place |
| Session | Login issues an httpOnly, `SameSite=Strict`, `Secure`, `__Host-` cookie with a bounded lifetime. Logout invalidates server-side. `SESSION_COOKIE_INSECURE` drops `Secure`+`__Host-` for a plain-HTTP install and nothing else |
| CSRF | A token is required on every mutating admin request. `SameSite=Strict` is the belt; the token is the braces |
| Throttling | Per-IP and per-account login attempt throttling with backoff. Failed logins are audit events |
| 2FA | `ADMIN_TOTP_SECRET` is **DEFERRED** |

**The two credential spaces are completely separate.** A router key authenticates the data plane and
nothing else: it is never accepted on an admin route, cannot mint or read keys, cannot list accounts,
and cannot reach `/api/admin/**`. There is no scope, no flag, and no configuration that promotes a router
key into the admin plane. Conversely, an admin session is not accepted on `/v1/**`.

## Redaction

| Rule | |
|---|---|
| Default-on | The redactor runs on every log record, not at call sites. Forgetting to redact is not a possible mistake |
| What it catches | `mar_live_…` values, `Authorization` / `x-api-key` / `Cookie` headers, provider token and API-key shapes, OAuth `code`, `state`, `code_verifier`, refresh tokens |
| Tested unit | Pure function, its own test file, with fixtures per secret shape. A new provider credential shape means a new fixture |
| Bodies | Request and response bodies are never logged, at any level. Prompts are user data |
| Client-facing errors | No credential, no token fragment, no decrypted material, and no upstream account identity ever appears in an error returned to a client — see [06-protocol-translation.md](06-protocol-translation.md) |

## OAuth flow safety

The connect and reconnect flows are described in [03-providers.md](03-providers.md). Their security
rules:

| Rule | |
|---|---|
| PKCE | Every authorization-code flow uses PKCE. The `code_verifier` is generated and kept **server-side** and never reaches the browser |
| `state` | One-shot, single-use, high-entropy, generated server-side, bound to a specific pending account row |
| TTL | `state` + verifier expire after **10 minutes**; the janitor purges them (see [09-deployment.md](09-deployment.md)) |
| Rejection | A mismatched, expired, already-consumed, or unbound `state` is rejected outright — no partial exchange, no retry with the same value |
| Pending rows | The pending account row exists before the redirect and is cleaned up if the flow never completes. No half-created accounts |
| Both modes | Redirect capture and manual `code#state` paste converge on the same server-side exchange step and the same checks |
| Display | Tokens, refresh tokens, and codes are never rendered in the UI after exchange |
| At rest | The verifier is an AES-256-GCM envelope; the `state` is stored as-is, because it is the lookup key a callback presents and a value the database must match cannot also be ciphertext |
| Uniform rejection | Unknown, consumed, expired, unbound, and bound-elsewhere all answer the same sentence. A callback that explains *why* it refused is a probe oracle |

**The redirect callback is unguarded, and that is the design.** A provider's redirect is a
cross-site top-level navigation, so the `__Host-`/`SameSite=Strict` admin session cookie is not sent
with it and a guard would refuse every real callback. The one-shot `state` is the authorization: 256
bits minted server-side minutes earlier, bound to one Account row, redeemable once. It is mounted at
its own published path (`PUBLIC_URL + /admin/accounts/oauth/callback`), it reaches exactly one
service call, and the page it answers escapes everything it renders.

Consume **then** check: the `state` is redeemed before the binding is judged, so a wrong guess burns
it rather than leaving it available for another try. Claude subscriptions do the same with their
pending login ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §3.1).

## Blast radius

| If this leaks | Then |
|---|---|
| One router key | That key's pools can be used until it is revoked. Revocation is instant and affects nothing else. No upstream credential rotates |
| **A host-executing SDK tool becomes reachable** (the allowlist regresses) | Everything, from any valid key, without touching the admin plane: `ENCRYPTION_KEY` and `DATABASE_URL` read from the process environment, the database decrypted with them, every Account's `CLAUDE_CONFIG_DIR`, and code execution on the host itself. Strictly worse than any leak below it, because it produces them all. This is why the allowlist is explicit and why a test gates it |
| The database alone (dump, replica, volume) | Metadata, usage history, and audit trail are exposed. Credentials and key values are ciphertext — not usable |
| `ENCRYPTION_KEY` alone | Nothing, without the database |
| **Database + `ENCRYPTION_KEY`** | Total compromise: every upstream credential and every router key. Rotate upstream credentials, re-auth every OAuth account, mint new keys, and rotate `ENCRYPTION_KEY` |
| The `CLAUDE_CONFIG_DIR` volume | Every Claude subscription it holds, immediately and without `ENCRYPTION_KEY` — the credentials are live in the SDK's own format. Recovery is re-running the SDK login for each affected Account, which invalidates the old directory |
| The admin password | Full control of the admin plane: keys can be read and minted, accounts read (but not their credentials — no endpoint returns them) |
| Logs | Metadata only: request ids, model names, token counts, account labels. No prompts, no credentials |
| An admin session cookie | Admin-plane access until the session expires or is invalidated |

## Hardening checklist

For operators, at deploy time:

- Put the router behind a reverse proxy that terminates HTTPS. Do not publish the container port.
- Do **not** expose the admin plane (`/api/admin/**`, the SPA) to the public internet — bind it to a
  private network, a VPN, or an authenticating proxy. The data plane can be public; the admin plane
  has no reason to be.
- Generate `ENCRYPTION_KEY` from a CSPRNG (32 bytes, base64). Store it in a secret store if you have
  one. Never commit it. Never reuse it across deployments.
- Prefer `ADMIN_PASSWORD_HASH` over `ADMIN_PASSWORD` once you are past first boot.
- Back up the Postgres database (`pg_dump` or a volume snapshot) — and back up `ENCRYPTION_KEY`
  separately, somewhere the database backup is not. A backup of one without the other is useless; a
  backup of both in one place is the whole compromise in one file.
- **Back up the `CLAUDE_CONFIG_DIR` volume as secret material, not as data.** It holds live Claude
  subscription credentials, and `ENCRYPTION_KEY` does not protect it. Mode `0700` on the directory
  tree, owned by the non-root container user, excluded from any log or metrics collection path.
- Do not expose the Postgres port outside the compose network; run the container as a non-root user.
- Set `TRUST_PROXY` only when a proxy you control is actually in front.
- Leave `SESSION_COOKIE_INSECURE` unset. It is only for a plain-HTTP LAN install, where the
  hardened session cookie is discarded by the browser and login silently fails; the moment HTTPS
  is in front, unset it. The router logs a `warn` naming the risk on every boot while it is on.
- Give every key a name and the narrowest pool binding that works. Revoke keys you no longer
  recognize — see [04-api-keys-and-access.md](04-api-keys-and-access.md).
- Watch the audit log and the account health panel; an unexpected `needs_reauth` or `exhausted`
  account is worth a look ([08-observability.md](08-observability.md)).

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Where auth, decryption, and redaction sit in the request lifecycle |
| [03-providers.md](03-providers.md) | OAuth constants, refresh, and the `needs_reauth` state |
| [04-api-keys-and-access.md](04-api-keys-and-access.md) | Key lifecycle, scopes, pool binding, rate limits |
| [09-deployment.md](09-deployment.md) | Env validation, volume layout, retention knobs |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | Why Claude subs hold no bearer token, how the per-Account config dirs work, and the tool-passthrough mechanics in full (§7) |
