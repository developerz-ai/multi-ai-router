# Providers

Status: the driver contract, the total registry, and sixteen HTTP drivers are **implemented**
(`apps/api/src/providers/`). `anthropic-oauth` is served by the Agent SDK; every other declared id
has an HTTP driver. Every constant below is pinned in code with a provenance comment; where this
page and a driver file disagree, the driver file is the truth.

## Provider vs Account

| Term | What it is | Where it lives |
|---|---|---|
| **Provider** | A *kind* of upstream — its dialect, its auth mechanism, its endpoints, its quirks. | Code. A static registry, one file per provider under `providers/`. Not a database table. |
| **Account** | *One credential* to one Provider — one Claude Max login, one OpenRouter key. Has a required `label`. | Database, credential material encrypted at rest. |

A Provider has no state; an Account has status, weight, priority, health, and an optional model
alias map. See [02-domain-model.md](02-domain-model.md).

### Many Accounts per Provider is the normal case

**This is the point of the product.** You do not attach one account per provider — you attach
*N accounts of the same kind*, distinguished by their `label`:

| Provider | Accounts you might attach |
|---|---|
| `anthropic-oauth` | `claude-sebastian`, `claude-team-1`, `claude-team-2`, `claude-ci`, `claude-spare` |
| `openai-oauth` | `chatgpt-sebastian`, `chatgpt-ci` |
| `zai` | `zai-primary`, `zai-secondary`, `zai-overflow` |
| `openrouter` | `openrouter-fallback` |

All eleven of those can sit in one Pool. Pooling several accounts *of the same kind* is exactly
what makes load balancing and failover worth having: five Claude Max subscriptions in one pool
means five independent 5-hour quota windows, and a session that exhausts one moves to the next.
Nothing in the design — routing, filtering, failover, quota math, accounting — may assume one
account per provider.

`label` is the operator's handle for an Account and is required. It is what appears in the
admin UI, in usage breakdowns, and in logs; the credential itself never appears anywhere.

## Registry

| id | Auth kind | Native dialect | Base URL | Notes |
|---|---|---|---|---|
| `anthropic-oauth` | **Claude Agent SDK** — `claude` CLI login into a per-Account `CLAUDE_CONFIG_DIR` | Anthropic Messages, re-synthesized from SDK output | none — no HTTP base URL; the SDK subprocess owns the transport | Claude Max/Pro subscription. **No token injection, no direct call to `api.anthropic.com`.** Quota from SDK `rate_limit_event` events. See [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md). |
| `anthropic-api` | API key | Anthropic Messages | `https://api.anthropic.com` | Pay-as-you-go console key. Ordinary HTTP driver: `x-api-key` + `anthropic-version: 2023-06-01`. **Unaffected by the subscription/SDK path.** |
| `openai-oauth` | OAuth (authorization code + PKCE) | OpenAI Responses | `https://chatgpt.com/backend-api/codex` | ChatGPT/Codex subscription. Requires `chatgpt-account-id`. |
| `openai-api` | API key | OpenAI Chat Completions / Responses | `https://api.openai.com/v1` | Standard platform key. |
| `openrouter` | API key | OpenAI Chat Completions | `https://openrouter.ai/api/v1` | Aggregator; model ids are namespaced (`vendor/model`), so an alias map is usually required. |
| `zai` | API key, `Authorization: Bearer` | Anthropic **or** OpenAI | `https://api.z.ai/api/anthropic` (Anthropic) · `https://api.z.ai/api/coding/paas/v4` (OpenAI) | Two compatible surfaces; the Account picks one, and the choice decides the endpoint *and* the header form. Own model ids (`glm-5.2`, `glm-4.7`). |
| `kimi` | API key, `Authorization: Bearer` | Anthropic | `https://api.kimi.com/coding` | Own model ids (`k3`). **Never `x-api-key`** — see below. |
| `minimax` | API key, `Authorization: Bearer` | Anthropic | `https://api.minimax.io/anthropic` | Anthropic-compatible surface. Reports some failures in a `base_resp` envelope on an HTTP `200`. Own model ids, so an alias map is usually required. |
| `gemini` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://generativelanguage.googleapis.com/v1beta/openai` | Google's **OpenAI-compatibility** surface. Own model ids (`gemini-2.5-pro`, `gemini-2.5-flash`), so an alias map is usually required. Words failures as canonical gRPC statuses and reports the retry delay in the body, not a header — see below. The **native Google GenAI dialect stays deferred** ([10-roadmap.md](10-roadmap.md)): it is a fourth column in the translation matrix. |
| `groq` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://api.groq.com/openai/v1` | GroqCloud. Own ids for open-weight models, so an alias map is usually required. **Overloads `error.type` to name the limit that was hit** (`tokens`, `requests`), so its rules key on `code`; a spend limit is a `400 blocked_api_access`, and `498` is a flex-tier capacity refusal in the 4xx range. |
| `deepseek` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://api.deepseek.com` | Own model ids (`deepseek-chat`, `deepseek-reasoner`). The one vendor here whose statuses mean what they say — a spent balance is a real **`402 Insufficient Balance`**. Its `error.type` and `error.code` are inverted and inconsistent, so the driver reads neither. |
| `xai` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://api.x.ai/v1` | Grok. Answers in **two** error shapes — OpenAI's nested one and a flat `{code, error}` whose `code` is an English sentence. Publishes no status for a depleted balance, so the driver encodes none; regional hosts are an Account base-URL override. |
| `mistral` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://api.mistral.ai/v1` | **Error body has no `error` wrapper** — `{object:"error", message, type, param, code}` at the top level. Keys on `type` (four published categories) and never on `code`, which is a numeric string the docs describe as symbolic. |
| `together` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://api.together.ai/v1` | Namespaced model ids, so an alias map is usually required. **`403` means the prompt exceeded the context length, not a rejected credential**, and `503` is the platform's capacity rather than this account's budget. |
| `cerebras` | API key, `Authorization: Bearer` | OpenAI Chat Completions | `https://api.cerebras.ai/v1` | Shares Mistral's unwrapped error envelope. A spent free-tier **day** is a `429`, not a billing state — it refills on a clock. |
| `ollama` | **none** — a credential is optional, and sent as `Authorization: Bearer` when there is one | OpenAI Chat Completions | operator-supplied | A local or self-hosted Ollama. The only provider whose Account may hold **no credential at all**. No pinned endpoint on purpose: Ollama's own default is `http://localhost:11434`, and in a container that address is the *router*. |
| `openai-compatible` | API key | OpenAI Chat Completions | operator-supplied | Escape hatch. Any vLLM / LiteLLM / vendor endpoint that speaks OpenAI and takes a key. |
| `anthropic-compatible` | API key | Anthropic Messages | operator-supplied | Escape hatch for Anthropic-shaped endpoints. |

Base URLs are defaults. Every Account may override its base URL — that is what makes a
self-hosted or regional endpoint work without a new driver.

## Provider driver contract

Each driver satisfies one interface. Signatures and responsibilities only — no bodies, and no
driver reaches for a clock, a store, or a logger it was not handed.

```ts
interface ProviderDriver {
  readonly id: ProviderId;
  // The surface used when the Account expresses no preference.
  readonly dialect: 'anthropic' | 'openai-chat' | 'openai-responses';
  // `none` is the local endpoint that authenticates nobody — the only value under which a
  // driver will address an upstream with no credential at all.
  readonly authKind: 'api-key' | 'oauth' | 'none';

  // Where this Account's requests go. Account override wins over the pinned default.
  resolveBaseUrl(account: DriverAccount): URL;

  // Which surface this Account chose — the input to the passthrough-vs-translate decision.
  resolveDialect(account: DriverAccount): Dialect;

  // Auth + provider-mandated headers for one upstream request. Never mutates the Account.
  // `null` only where `authKind` is `none`: the mandated headers still go, the auth header
  // does not. Any other provider handed `null` is refused, never sent unauthenticated.
  buildHeaders(account: DriverAccount, credential: ProviderCredential | null): Headers;

  // Client model name -> upstream model id, via the Account's alias map.
  // Identity when the Account has no entry for that name.
  mapModelAlias(account: DriverAccount, requestedModel: string): string;

  // Read rate-limit / quota signals out of an upstream response (headers and/or body).
  // Pure over the response; returns null when the provider says nothing.
  parseRateLimit(response: UpstreamResponse): RateLimitSignal | null;

  // What this response means as a failure, or null if it is not one. Accepts a 2xx,
  // because some providers report a dead balance in the body of a 200.
  classifyFailure(response: UpstreamResponse): FailureClassification | null;
}
```

| Member | Responsibility | Must not |
|---|---|---|
| `resolveBaseUrl` | Apply the Account override, else the pinned default. | Encode per-request path knowledge. |
| `resolveDialect` | Report the Account's chosen surface. | Decide whether translation happens — it only supplies the fact. |
| `buildHeaders` | Inject the credential and every provider-mandated header (beta flags, account id). | Log or return credential material. |
| `mapModelAlias` | Translate one name. Identity on miss. | Choose a *different* model on the client's behalf. |
| `parseRateLimit` | Normalize provider-specific reset/utilization signals into one shape. Never estimate: a reset the provider did not report is `unknown`, not a guess. | Decide policy — that is [05-routing-and-failover.md](05-routing-and-failover.md)'s job. |
| `classifyFailure` | Say what the upstream signal *means* — `rate-limited`, `credits-exhausted`, `auth`, … — and record which signal decided it. | Decide what to do about it. Retrying, cooling down, and marking `exhausted` are routing's. |

Every member is **pure**: no clock, no store, no logger, no network. `RateLimitSignal` carries at
minimum whether the account is limited now, the reported reset instant (if any), and per-window
utilization (if any), each labeled with its source.

Two members from the original design are **deliberately absent**: `probeHealth` (I/O, owned by the
half-open probe) and `refreshCredentials` (I/O as well). `openai-oauth` is what settles the second
one — its driver file owns the token-request shapes as pure builders, while the fetch, the timers,
and the single-flighting live in `services/accounts/`, so the interface stays pure and this narrow.

### The registry is total, and says why when there is no driver

The registry is a **total** record keyed by `ProviderId`, so adding an id in `packages/core` fails
the registry to compile until it is accounted for — the Open/Closed rule with a compiler behind it.
Every id is present, and the ones without an HTTP driver carry a reason rather than being silently
absent or stubbed into something that looks like it works:

| Transport | Ids | Meaning |
|---|---|---|
| `http` | `anthropic-api`, `openai-api`, `openai-oauth`, `openrouter`, `zai`, `kimi`, `minimax`, `gemini`, `groq`, `deepseek`, `xai`, `mistral`, `together`, `cerebras`, `ollama`, `openai-compatible`, `anthropic-compatible` | A driver in `providers/drivers/`, satisfying the interface above |
| `agent-sdk` | `anthropic-oauth` | Served by `query()`. Its own driver interface in `providers/claude-sdk/driver.ts`, not a `ProviderDriver`: there is no base URL to resolve, no headers to build, and failures arrive as strings |
| `unimplemented` | *(none today)* | Where an id declared in `packages/core` ahead of its driver lands. Selecting one is a configuration error, refused by name before any upstream call. Kept rather than deleted because that is the whole point of a total registry — the alternative is a new id compiling into a half-wired provider |

That three-way split is what lets the data plane refuse honestly, and it is also the **transport
seam**: `transport` is the discriminant every caller narrows on, so "is this HTTP or the Agent SDK"
is a question the compiler answers rather than a provider-id comparison scattered across the data
plane. A request routed to an account whose provider has no implementation fails saying so; it never
degrades into a lossy approximation.

## `anthropic-oauth` — Claude Max/Pro subscription, via the Claude Agent SDK

**Requests to a Claude subscription do not leave this router as HTTP.** They go through
`@anthropic-ai/claude-agent-sdk`'s `query()` — the documented, first-party programmatic entry
point. No OAuth token is extracted, no request is forged against `api.anthropic.com` with a
borrowed subscription token, no binary is patched. Anthropic keeps control of authentication,
prompt caching, context management, compaction, and rate limiting, because the router depends on
their mechanisms instead of routing around them.

| Property | Value |
|---|---|
| Transport | `@anthropic-ai/claude-agent-sdk` → `query()`, one subprocess per request |
| Credential store | one **`CLAUDE_CONFIG_DIR` per Account** — isolated, owned by the CLI, so N subscriptions coexist with no cross-contamination |
| Login | the `claude` CLI's own flow, driven by the router. The admin UI shows the authorization URL and takes the pasted `code#state` back, then hands it to the CLI |
| Second credential form | a long-lived token from `claude setup-token` |
| Refresh | happens inside the config directory. **The router never mints, stores, or attaches a subscription token** |
| Reconnect | `POST /api/admin/accounts/:id/reconnect` re-runs the same CLI login against the same directory, preserving id, pool membership, and usage history |
| Credential probe | `claude auth status --json` against the Account's directory, carried by **Re-check now**. Local, unbilled, and the only thing that makes a silently revoked login visible before every request has failed |
| Runtime requirement | the `claude` CLI present in the image |
| Quota signal | the SDK's `rate_limit_event` stream events (below) |
| Usage endpoint | `GET https://api.anthropic.com/api/oauth/usage` — **optional and secondary**, never the primary source |

**Why, plainly:** the point of the router is to make a team's subscriptions usable, and that only
works if the accounts survive. **Injecting subscription OAuth tokens into raw HTTP calls is the
fast path to a banned account** — that is the *rejected* approach, and it is rejected on account
safety, not on taste.

**Costs we accept, stated plainly:** a subprocess per request (heavier than an HTTP proxy hop);
the `claude` CLI has to ship in the image; and **protocol re-synthesis** — the SDK's output must
be rendered back into Anthropic/OpenAI wire format, which is where the per-client adapter work
lives. The path is slower and heavier and we take it anyway.

### Quota signals — `rate_limit_event`

The SDK emits `rate_limit_event` stream events; those are the primary quota source.

| Field | Meaning |
|---|---|
| `status` | The window's current limit state |
| `resetsAt` | When the window refills — feeds the circuit breaker directly |
| `rateLimitType` | Which window (below) |
| `utilization` | How much of the window is spent — feeds `quota-aware` |

| `rateLimitType` | Meaning |
|---|---|
| `five_hour` | Rolling 5-hour subscription allowance |
| `seven_day` | Rolling 7-day overall allowance |
| `seven_day_opus` | 7-day allowance scoped to the Opus tier |
| `seven_day_sonnet` | 7-day allowance scoped to the Sonnet tier |

Normalized into `RateLimitSignal` / `HealthProbe`, these feed two consumers: the `quota-aware`
policy (prefer the account with the most headroom) and the circuit breaker (an exhausted window
sets `cooling_down` until `resetsAt`). Snapshots are cached on a short TTL with concurrent reads
deduped per account; a transient gap serves the last-good snapshot rather than blanking the
routing view.

Full mechanics — SDK invocation shape, config-directory layout, subprocess lifecycle, and the
re-synthesis contract — live in [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md). This page
does not duplicate them.

## `anthropic-api` is untouched by all of that

**Only *subscription* accounts take the SDK path.** An Anthropic **API key** is ordinary,
sanctioned API usage: plain HTTP to `https://api.anthropic.com/v1/messages` through the normal
HTTP driver — no subprocess, no config directory, no `claude` CLI, no re-synthesis. The two share
a vendor and nothing else; treat them as separate providers, because they are.

The header rules for a **first-party Anthropic** request (`anthropic-api`, and any
`anthropic-compatible` Account pointed at Anthropic itself):

| Credential | Headers |
|---|---|
| API key | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| OAuth / subscription token | `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` + `anthropic-version: 2023-06-01` |

`anthropic-version: 2023-06-01` is **always** required. An OAuth token on `x-api-key` **does not
work**, and a Bearer token without the `oauth-2025-04-20` beta header does not either —
converting between the two forms is a header change, not a key swap. The router does not emit
Bearer-token Anthropic requests for Claude subscriptions (those go through the SDK), but the rule
stands for any operator-supplied Account that carries such a token.

### Anthropic-compatible vendors use `Authorization: Bearer`, not `x-api-key`

An earlier revision of this doc lumped z.ai, Kimi, and MiniMax into the table above. **That was
wrong.** Those vendors document their key as Claude Code's `ANTHROPIC_AUTH_TOKEN`, and Claude Code
sends `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer` — not as `x-api-key`. The vendor setup
snippets are all of this shape:

```sh
ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"  claude
ANTHROPIC_AUTH_TOKEN="$KIMI_API_KEY" ANTHROPIC_BASE_URL="https://api.kimi.com/coding"     claude
```

So: **`anthropic-api` → `x-api-key`; z.ai / Kimi / MiniMax on their Anthropic surfaces →
`Authorization: Bearer`.** They share a *dialect*, not an *auth scheme*, and the driver layer is
exactly where that distinction belongs. Note these vendors do **not** want the
`anthropic-beta: oauth-2025-04-20` header — that beta is specific to real Anthropic subscription
tokens; a compatible vendor's Bearer key is just a key.

## `openai-oauth` — ChatGPT/Codex subscription

| Constant | Value |
|---|---|
| Flow | OAuth 2.0 authorization code + PKCE (S256) |
| Issuer | `https://auth.openai.com` |
| Client id | `app_EMoamEEZ73f0CkXaXp7hrann` (pinned; matches the first-party client) |
| Scope | `openid profile email offline_access` |
| Authorize | `<issuer>/oauth/authorize` |
| Token | `<issuer>/oauth/token` |
| Authorize query | `response_type=code`, `client_id`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `id_token_add_organizations=true`, `state` |
| Code exchange | `grant_type=authorization_code` + `code`, `redirect_uri`, `client_id`, `code_verifier` (form-encoded) |
| Refresh | `grant_type=refresh_token` + `refresh_token`, `client_id`, `scope=openid profile email` — **JSON body**, not form-encoded |
| Loopback redirect | `http://localhost:1455/auth/callback` — the value the first-party client registers |
| Base URL | `https://chatgpt.com/backend-api/codex` |
| Auth header | `Authorization: Bearer <access_token>` |
| Required header | `chatgpt-account-id: <account id>` |
| Account-id claim | `https://api.openai.com/auth` → `chatgpt_account_id` |

All of it lives in `providers/drivers/openai-oauth.ts`, including the two token requests as pure
builders: the driver owns the *shapes*, the connect flow and the refresher own the fetch, the
timers, and the single-flighting. A provider change touches that one file.

`offline_access` is what earns the refresh token; without it the account degrades to
`needs_reauth` at first expiry. The refresh deliberately asks for less — it does not re-issue the
grant, and the first-party client omits `offline_access` there. `id_token_add_organizations=true`
mirrors the same client: it enriches the claim the account id is read from.

The account id is **derived, not configured** — decoded from the `id_token` claims (falling back to
the `access_token` claims), then stored on the Account and sent on every request. Deriving it wrong
produces upstream 401/403s that look like a bad token, so it is captured once at connect time and
re-derived on every refresh. A token that carries no such claim is refused *before* the request
goes out, as an upstream-auth failure naming the account — sending a Codex call without the header
would return a 401 the operator would misread as a bad token.

**A subscription has no balance to drain**, so its refusals are read differently from an API key's:
a spent 5-hour or weekly window is `rate-limited` (clock-recoverable, `cooling_down`), and the
`resets_in_seconds` the payload carries is used as the reported reset instead of the breaker's
guess. Only a deactivated plan is `credits-exhausted` — permanent until a human acts.

### Connecting one

`services/accounts/connect/oauth.ts` drives the flow and names no provider: it works for any driver
that advertises a `ProviderOAuthFlow` — the four pure builders above under provider-independent
names. Adding the second OAuth provider is still one file under `providers/drivers/`.

The Account row is created **first**, with no credential and status `needs_reauth`: it is what the
one-shot `state` binds to, and `needs_reauth` keeps it out of routing until the login lands rather
than letting selection pick an Account with nothing to authenticate with. `POST /:id/connect` mints
a 256-bit `state` and an S256 PKCE verifier, stores the verifier as an AES-256-GCM envelope, and
answers with the provider's authorization URL.

| Step | |
|---|---|
| `redirect_uri` | `PUBLIC_URL + /admin/accounts/oauth/callback` when a `PUBLIC_URL` is set, otherwise the first-party client's `http://localhost:1455/auth/callback`. Stored on the pending row and **replayed** at the exchange — the provider binds the code to the exact value, and `PUBLIC_URL` may be edited in between |
| Redirect capture | The browser lands on `GET /admin/accounts/oauth/callback`. Unguarded by design: a provider's redirect is a cross-site navigation, so the `SameSite=Strict` session cookie is not sent, and the `state` is the authorization. It answers a small self-contained HTML page, the one non-JSON surface on the admin plane |
| Paste capture | `POST /:id/connect/complete` with whatever the address bar held — the whole callback URL, a bare query string, or the `code#state` shorthand. Available in *both* modes: a callback the browser cannot load still leaves the code in the address bar, which is what makes an unreachable `PUBLIC_URL` a non-event |
| The exchange | One code exchange, one write: `{accessToken, refreshToken}` encrypted into `authMaterial`, `tokenExpiresAt` from `expires_in`, `needs_reauth` cleared — and nothing else, because a `disabled` Account stays disabled |
| Restart / cancel | A second `POST /:id/connect` retires whatever the last one left redeemable, and `DELETE /:id/connect` does the same on demand. One live authorization per Account |
| Which audit kind | Derived, not declared: an Account that already held a credential was re-connected (`account.reauthorized`), one that did not was connected (`account.connected`). The event records the capture mode and never a code, a `state`, or a token |

Every rejection — unknown, consumed, expired, unbound, or bound to a different Account — answers
one sentence, because a callback that explains *why* it refused is a probe oracle. Rules in
[07-security.md](07-security.md).

## `gemini` — Google's OpenAI-compatibility surface

Gemini is reached over the endpoint Google publishes for stock OpenAI clients, **not** the native
Google GenAI protocol. That is a scope line, not an oversight: a native dialect is a fourth column in
the [translation matrix](06-protocol-translation.md) and the two-dialect matrix earns it first
([10-roadmap.md](10-roadmap.md)). Everything else about the account is ordinary — one `openai-chat`
surface, the key on `Authorization: Bearer`, an alias map for Google's own model ids.

| Property | Value |
|---|---|
| Base URL | `https://generativelanguage.googleapis.com/v1beta/openai` — already carries its version segment the way OpenAI's `/v1` does, so `{base}/chat/completions`, `{base}/embeddings`, and `{base}/models` are the addresses built |
| Auth header | `Authorization: Bearer <api key>`. No `x-goog-api-key`, no query-string key |
| Dialect | `openai-chat` only. An account pinned to `openai-responses` is refused at write time — Google's compatibility layer states no Responses endpoint |
| Vertex / regional | an Account base-URL override, not a second pinned constant |

Two things make this more than a base URL, and both are the difference between a correct verdict and
a plausible one:

| Google's shape | Why the shared reader is not enough |
|---|---|
| `error.status` carries the canonical gRPC status (`RESOURCE_EXHAUSTED`, `UNAUTHENTICATED`, `FAILED_PRECONDITION`, `UNAVAILABLE`, …) beside a numeric `error.code` that only restates the HTTP status | No OpenAI-shaped client reads `status`, so the shared envelope does not carry it. Without lifting it into the facts, every Gemini failure classifies on the HTTP status alone — and `RESOURCE_EXHAUSTED` then reads as a bare `429` with no way to tell it from the wording trap below |
| the retry delay rides `error.details[]` as a `google.rpc.RetryInfo` protobuf Duration (`"31s"`) | Gemini sends **no** `x-ratelimit-*` family and **no** `Retry-After`. That body field is the only reset it ever reports, so without reading it every Gemini `429` has a reset of `unknown` and the breaker backs off on its own guess instead of the provider's number |

`RetryInfo` is attached **only** to a reading that already says `limited`. It rides an `UNAVAILABLE`
too, where it is a backoff hint about the service and says nothing about this credential's window.

A rejected key arrives in two forms and both are `auth`: `UNAUTHENTICATED` (401) on the
compatibility surface, and `INVALID_ARGUMENT` (400) with the message `API key not valid` from the
Generative Language API behind it. Classified on the status alone, the second reads as a client
mistake — the operator then debugs the request instead of the credential.

## The OpenAI-shaped fleet — Groq, DeepSeek, xAI, Mistral, Together, Cerebras

Six vendors that all speak OpenAI Chat Completions and differ only in how each words a failure. Each
is a pinned id rather than an `openai-compatible` account, and the difference is worth naming: an id
carries the endpoint, the credit-exhaustion rules, and an operator's ability to see *which* upstream
a pool is spending. An escape-hatch account carries a URL and one shared wording guess.

What separates them is a short list of traps, each of which turns a correct verdict into a plausible
one:

| Vendor | The trap | What the driver does about it |
|---|---|---|
| `groq` | `error.type` names the **limit that was hit** (`tokens`, `requests`), not the kind of error — and a spend limit arrives as a `400`, while `498` is a capacity refusal inside the 4xx range | Every rule keys on `code`. `blocked_api_access` is `exhausted`; `498` is a `server-error`, so it fails over instead of failing the request |
| `deepseek` | `type` and `code` are inverted — a `402` carries `type: "unknown_error"` beside `code: "invalid_request_error"` | Reads neither. DeepSeek's statuses are honest, including the `402` almost nobody else sends, so the status carries the verdict and one wording rule names it |
| `xai` | Two error shapes, one of them flat with an English sentence in `code`; and **no published status for a depleted balance** | Reads the message, never `code`. Encodes no xAI-specific credit rule — a guess parks a healthy account where no clock reaches it |
| `mistral` | The body has **no `error` wrapper**, so the shared reader finds nothing; `code` is a numeric string the docs describe as symbolic | Reads the unwrapped envelope, keys on the four published `type` categories, and matches the "service tier capacity exceeded" *message*, whose codes disagree between captures |
| `together` | **`403` is an oversized prompt**, not a rejected credential; `503` is the platform out of capacity, not this account over budget | `403` → `invalid-request`, so the key is never flagged for a client's mistake. `503` keeps the status default's `server-error` |
| `cerebras` | Same unwrapped envelope as Mistral; a spent **daily** token allowance is a `429` | Shares the reader. The throttle guard keeps a spent day a cooldown — it refills on a clock, and `exhausted` would wait for a human who has nothing to do |

Where a vendor publishes no billing status at all, the driver falls back to the *shared* wording rule
the escape hatches use, and records `compatible:out-of-credits-wording` as the signal — which says
out loud that the verdict came from phrasing rather than from a vocabulary the vendor publishes.
That rule is always ordered **behind** a guard that reads any `429` as a cooldown, because the one
thing worse than not recognizing a dead balance is inventing one out of a throttle message.

## API-key providers — z.ai, Kimi, MiniMax, OpenRouter, Gemini, and the OpenAI-shaped fleet

No refresh, no expiry, no OAuth state. An Account is a base URL, a key, and an alias map.
Valid until revoked upstream; a 401 moves the Account to `disabled`, not `needs_reauth`.

These are the providers whose money can run out — a prepaid balance for most of them, a billing
account for Gemini — so their drivers carry the other half of the job: recognizing that response,
which each words differently, and reporting it as `exhausted` rather than a cooldown, because no
clock refills a dead balance. See [05-routing-and-failover.md](05-routing-and-failover.md).

### Credit exhaustion, per provider — what the upstream actually says

Every value below is a pinned constant in that provider's driver file, with a provenance comment
next to it. They are here because an operator staring at a `402` needs to know what the upstream
said to earn it, and because **getting one wrong is invisible until it costs a pool**: an
unrecognized dead balance classifies as a generic error, the account is never marked `exhausted`,
and the router keeps selecting a credential that can no longer serve a request.

| Provider | Signal the driver keys on | Why it is not just the status code |
|---|---|---|
| `anthropic-api` | message matches `credit balance is too low`; or `error.type` is `billing_error` | Anthropic answers a spent console balance with **`400 invalid_request_error`**. Read the status alone and it classifies as a client mistake |
| `openai-api` | `error.code` / `error.type` in `insufficient_quota`, `billing_hard_limit_reached`, `account_deactivated` | OpenAI returns **`429`** for a spent balance — the same status it uses for real rate limiting. Status alone marks a dead account `cooling_down` and retries it on a timer forever |
| `openrouter` | message matches `insufficient credits` / `requires more credits` / `add more using`; or `error.code` is `402` | OpenRouter echoes the numeric HTTP status back in `error.code` rather than a string. The wording rule is what still catches it when the `402` is proxied through with another status |
| `zai` | `error.code` in `1113`, `1112`; or message matches `insufficient balance` / `balance is insufficient` / `account balance` | Numeric vendor codes on both surfaces. `130x` is throttling and `100x` is auth — three families that all arrive as one HTTP status |
| `kimi` | `error.type` is `exceeded_current_quota_error`; or message matches `insufficient balance` / `account … not active` | Anthropic-shaped body, Moonshot's own `type` vocabulary. Without it the account cools down on a timer instead of being flagged for a human |
| `minimax` | `base_resp.status_code` is `1008` | **MiniMax reports failures in a `base_resp` envelope that can arrive with HTTP 200.** A driver reading only the status sees a success and hands an error body to the client as a completion |
| `gemini` | message matches `enable billing` / `requires billing` / `billing account … not found` / `has been suspended` — and **nothing else** | Google's `RESOURCE_EXHAUSTED` (429) covers a per-minute limit *and* a spent free-tier day, and its message says "check your plan and billing details". Both refill on a clock, so both are `cooling_down`. Keying on the word "billing" would flip every throttled request to `exhausted` and pull a healthy key out of the pool. Only a project with billing off, a billing account that no longer resolves, or a suspended project is permanent |
| `groq` | `error.code` is `blocked_api_access` — on an HTTP **400** | Groq's only documented billing-dead signal is a spend limit, and it wears the status of a malformed request. Read the status alone and a blocked organization is debugged as a bad request while it fails every call it is handed |
| `deepseek` | HTTP `402`; message matches `insufficient balance` | The one vendor here that answers a spent balance with the status that means it. The wording rule exists for the relayed case and to record a signal better than `http-status:402` |
| `together` | HTTP `402` — a monthly spending cap | Documented and unambiguous. What is *not* documented is the status a zero prepaid balance returns, and Together is fully prepaid, so the shared wording rule stands behind the status |
| `cerebras` | HTTP `402`, and nothing else | Cerebras' error page lists statuses only. A spent free-tier **day**, by contrast, is a `429` — clock-recoverable, never `exhausted` |
| `xai`, `mistral` | one shared wording rule, behind a guard that reads any `429` as a cooldown | Neither publishes a status for a depleted balance or a spend-suspended workspace. Encoding a guess is how a healthy account gets parked at `402`, so neither driver encodes one; the shared phrasing is the whole of it, and the signal it records says so |
| `ollama` | the same shared wording rule, behind the `429` throttle guard | A local endpoint has no balance to drain, so nothing here is Ollama's own vocabulary — but a hosted or proxied surface reached through this id can refuse one, and its limits are hourly and daily. The throttle guard leads so a spent hour can never read as a dead balance |
| `openai-compatible`, `anthropic-compatible` | one shared wording rule — `insufficient quota/credits/balance`, `out of credits`, `quota exceeded/exhausted` — guarded by an error status | The endpoint behind these is unknown. Guessing at a vendor's error vocabulary produces confident misclassifications, so this is deliberately the *only* wording either matches. The status guard is what stops a completion containing the word "quota" reading as a billing stop. **No 429 guard here**, unlike the pinned vendors: behind an escape hatch may sit an OpenAI-shaped endpoint, where a `429` genuinely *is* a spent balance |

Each classification also records **which signal decided it** (`openai:insufficient_quota`,
`minimax:base_resp-1008`, …) so a misclassification is debuggable rather than a mystery. Expect
drift: a vendor renaming a code is a one-file fix, and that is the whole point of pinning them.

The interesting part is the **model alias map**. These providers expect their own model ids,
while a client like Claude Code sends `opus`, `sonnet`, or `haiku` and has no idea it is
talking to anything else. The router honors the client's model name (that is the central
invariant) — the alias map is the one place where an Account declares "when this key is used,
that name means this id upstream."

| Client sends | Account alias map | Upstream receives |
|---|---|---|
| `sonnet` | `sonnet → glm-4.7` (a z.ai Account) | `glm-4.7` |
| `opus` | `opus → glm-5.2` (a z.ai Account) | `glm-5.2` |
| `sonnet` | `sonnet → k3` (a Kimi Account) | `k3` |
| `sonnet` | `sonnet → gemini-2.5-flash` (a Gemini Account) | `gemini-2.5-flash` |
| `sonnet` | *no entry* | `sonnet`, unchanged |

Rules:

- The map is **per Account**, not per Provider — two z.ai keys may map differently.
- **No entry means passthrough.** The router never guesses a substitute, and never fails a
  request because a name is unmapped; the upstream's own error is the honest answer.
- An Account's alias map also defines "supports the requested model" for candidate filtering
  when the Account declares an explicit model set. See [05-routing-and-failover.md](05-routing-and-failover.md).
- Aliasing is a name swap only. It never rewrites the body — that is
  [06-protocol-translation.md](06-protocol-translation.md)'s job.

## `ollama` — a local endpoint, and the credential that is not required

Every other provider here is a key. Ollama, on the machine an operator already owns, is not: it
listens on a trusted network and authenticates nobody. So its driver declares `authKind: 'none'`,
and that single value is what the rest of the system reads:

| Layer | What `none` changes |
|---|---|
| Account writes (`services/accounts/rules.ts`) | An Account of this provider may be created with **no credential**. Nothing else may — the rule is asked of the descriptor, never of an id |
| Egress (`dataplane/egress/credential.ts`) | An empty Account yields `null` instead of raising. Every other empty Account is still a hard failure, because an anonymous request to a paid upstream is worse than a loud one |
| Headers (`providers/driver.ts`) | `null` builds no auth header. A `null` reaching a driver whose `authKind` is anything else is refused there too, so the permission cannot leak by accident |
| Breaker (`services/routing/breaker.ts`) | An auth failure lands on `disabled`, not `needs_reauth`: there is no login to re-run, and something has appeared in front of the endpoint that the operator has to configure |
| Console (`AccountFormDialog.tsx`) | The credential field stays, labelled optional. It is read off `authKind`, so no provider list lives in the SPA |

A credential is still **accepted**, and that is the point of "optional" rather than "forbidden": the
same Ollama put behind a reverse proxy, or a hosted surface, does check one, and it is presented as
`Authorization: Bearer` exactly like every other OpenAI-dialect provider.

Two more decisions worth stating out loud:

- **No pinned base URL.** Ollama's default is `http://localhost:11434`, and inside a container that
  address is the router itself — a pinned default would quietly address the wrong machine. The
  operator supplies the endpoint (`http://host.docker.internal:11434/v1`, `http://ollama:11434/v1`,
  a remote box), which is also what makes every one of those work with no driver change.
- **A model the node has not pulled is a `404`, and stays the client's answer.** The driver names the
  signal (`ollama:model-not-pulled`) but does not turn it into a retry onto some other account:
  deciding which node should serve a model is what an Account's declared model set is for
  ([05-routing-and-failover.md](05-routing-and-failover.md)), not something to infer from an error.

## Generic `openai-compatible` / `anthropic-compatible`

The escape hatch, and the reason the registry does not need to grow for every new vendor:

| Input | Required |
|---|---|
| Base URL | yes |
| API key | yes |
| Dialect | implied by which of the two ids you pick |
| Model alias map | optional |

No bespoke driver, no code change, no release. If a vendor exposes an OpenAI- or
Anthropic-shaped endpoint, it is already supported. A dedicated Provider id is only worth
adding when the vendor needs something the generic pair cannot express — OAuth, a mandatory
header, or a non-standard quota signal.

## Adding a provider

1. Add one file under `providers/drivers/<id>.ts`. Most providers are a `createHttpDriver({…})`
   call: declare the surfaces and how the vendor words a dead balance, and alias mapping, base-URL
   override, header rules, and rate-limit parsing compose from the shared body.
2. Pin its constants at the top of that file — base URL, error codes, required headers — each with
   a provenance comment and its blast radius.
3. Add its id to the `ProviderId` union in `packages/core`.
4. Register it in `providers/registry.ts`. The record is total, so this step is not optional —
   omitting it fails the build.
5. Add unit tests for `buildHeaders`, `mapModelAlias`, and `classifyFailure` — all pure.
6. Ship. Routing, keys, pools, usage, and the admin UI need no changes; the console reads the
   registry from `/api/admin/providers` rather than keeping its own list.

A provider that needs something the shared body cannot express supplies its own `readFacts` or
`parseRateLimit` (MiniMax does), or implements `ProviderDriver` directly. That escape hatch is why
the shared body is not a framework.

That is the Open/Closed rule from [01-architecture.md](01-architecture.md) in practice: adding a
provider touches one new file plus two registration lines, and nothing else.

### "Exactly one file" vs. three — why the non-negotiable isn't wrong

The repo's `CLAUDE.md` states the rule as **"adding a provider touches exactly one file in
`providers/`."** Taken literally against steps 1–4 above, that's three touches, not one:

| Touch | File | Why it can't be folded into the driver file |
|---|---|---|
| 1 | `providers/drivers/<id>.ts` (new) | The driver itself — surfaces, headers, alias mapping, failure vocabulary. |
| 2 | `packages/core`'s `ProviderId` union | The id has to exist as a *type* before anything can key a record on it. |
| 3 | `providers/registry.ts` | Wires the id to its driver (or to a recorded `unimplemented` reason). |

This is deliberate, not drift, and the reason is the same one that makes the registry worth having:
**`PROVIDER_REGISTRY` is a `Readonly<Record<ProviderId, ProviderSupport>>` — a total function from
the id type to its support.** A `Record` type in TypeScript is exhaustive by construction: if
`ProviderId` gains a member and `PROVIDER_REGISTRY` doesn't grow a matching key, the assignment
fails to compile. That totality is *why* an unimplemented id can never silently fall through to a
generic error at request time — the compiler refuses to link a provider id that has nothing wired
to it, before the router ever boots. Collapsing the union and the registry into the driver file
would remove the second party to that check: a single file has nothing to be exhaustive *against*.

So the non-negotiable's "one file" is the file that carries the provider's actual behavior — the
driver — and is true in the sense that matters: nothing about routing, keys, pools, usage, or the
admin UI changes, and no *existing* file's logic is touched. The other two touches are one line
each, mechanical, and fail loudly (a compile error, not a runtime surprise) if skipped. Read
"exactly one file" as "exactly one place where behavior is decided," with two one-line compiler
checkpoints that make skipping step 3 impossible rather than merely discouraged.

## Reverse-engineering posture

**Claude subscriptions are exempt** — they run on the first-party Claude Agent SDK, so there is
nothing to reverse-engineer and nothing to drift. What follows applies to the *other*
subscription flows (ChatGPT/Codex today), which are reverse-engineered from the official
first-party clients. The design treats that as a maintenance property, not a footnote:

| Rule | Why |
|---|---|
| Constants live in **one file per provider**, at the top, never inlined at call sites. | A provider changing its flow must touch exactly one file. |
| Every constant carries a **provenance comment** — where the value came from, what breaks without it. | The next maintainer should not have to re-derive it. |
| **Expect drift.** Client ids, scopes, beta headers, and endpoints can change without notice. | Treat a sudden 401/403 wave on one provider as a constants problem first. |
| Provider responses are **Zod-validated** at the boundary; unknown fields are tolerated, missing required fields fail loudly. | A silently reshaped payload should surface as a parse error, not as bad routing. |
| A broken flow degrades to `needs_reauth` on the affected Accounts, never to a failing data plane. | Other providers keep serving. |

See [09-deployment.md](09-deployment.md) and [10-roadmap.md](10-roadmap.md) for
the maintenance cadence, and [07-security.md](07-security.md) for how credentials are stored and
redacted.

## Read next

| Doc | Covers |
|---|---|
| [02-domain-model.md](02-domain-model.md) | Account fields, status machine, alias map storage |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | The Claude Agent SDK path in full — config dirs, subprocess, re-synthesis |
| [04-api-keys-and-access.md](04-api-keys-and-access.md) | Router keys, key scope, the two planes |
| [05-routing-and-failover.md](05-routing-and-failover.md) | How quota signals become account selection |
| [06-protocol-translation.md](06-protocol-translation.md) | Ingress × egress dialect matrix |
| [08-observability.md](08-observability.md) | Usage records, health surfaces, metrics |
