# Providers

Status: design only. No code exists yet. Everything here describes the intended base.

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
| `zai` | API key | Anthropic **or** OpenAI | `https://api.z.ai/api/anthropic` (Anthropic) · `https://api.z.ai/api/coding/paas/v4` (OpenAI) | Two compatible surfaces; the Account picks one. Own model ids (`glm-5.2`, `glm-4.7`). |
| `kimi` | API key | Anthropic | `https://api.kimi.com/coding` | Own model ids (`k3`). |
| `minimax` | API key | Anthropic | `https://api.minimax.io/anthropic` | Anthropic-compatible surface. Own model ids, so an alias map is usually required. |
| `gemini` | API key | **DEFERRED** — v1 reaches it through the OpenAI-compatible layer | **DEFERRED** | A native Google GenAI driver is not in v1; endpoint constants not yet pinned. |
| `openai-compatible` | API key | OpenAI Chat Completions | operator-supplied | Escape hatch. Any vLLM / Ollama / LiteLLM / vendor endpoint. |
| `anthropic-compatible` | API key | Anthropic Messages | operator-supplied | Escape hatch for Anthropic-shaped endpoints. |

Base URLs are defaults. Every Account may override its base URL — that is what makes a
self-hosted or regional endpoint work without a new driver.

## Provider driver contract

Each driver satisfies one interface. Signatures and responsibilities only — no bodies, and no
driver reaches for a clock, a store, or a logger it was not handed.

```ts
interface ProviderDriver {
  readonly id: ProviderId;
  readonly dialect: 'anthropic' | 'openai-chat' | 'openai-responses';
  readonly authKind: 'api-key' | 'oauth';

  // Where this Account's requests go. Account override wins over the registry default.
  resolveBaseUrl(account: Account): URL;

  // Auth + provider-mandated headers for one upstream request. Never mutates the Account.
  buildHeaders(account: Account, credential: DecryptedCredential): Headers;

  // Client model name -> upstream model id, via the Account's alias map.
  // Identity when the Account has no entry for that name.
  mapModelAlias(account: Account, requestedModel: string): string;

  // Read rate-limit / quota signals out of an upstream response (headers and/or body).
  // Pure over the response; returns null when the provider says nothing.
  parseRateLimit(response: UpstreamResponse): RateLimitSignal | null;

  // OAuth drivers only. Single-flight is the caller's job, not the driver's.
  refreshCredentials?(credential: DecryptedCredential): Promise<RefreshedCredential>;

  // Cheap liveness/quota probe for the health snapshot. No request body side effects.
  probeHealth(account: Account, credential: DecryptedCredential): Promise<HealthProbe>;
}
```

| Member | Responsibility | Must not |
|---|---|---|
| `resolveBaseUrl` | Apply the Account override, else the pinned default. | Encode per-request path knowledge. |
| `buildHeaders` | Inject the credential and every provider-mandated header (beta flags, account id). | Log or return credential material. |
| `mapModelAlias` | Translate one name. Identity on miss. | Choose a *different* model on the client's behalf. |
| `parseRateLimit` | Normalize provider-specific reset/utilization signals into one shape. | Decide policy — that is [05-routing-and-failover.md](05-routing-and-failover.md)'s job. |
| `refreshCredentials` | One token exchange. | Persist; the caller encrypts and writes. |
| `probeHealth` | Report reachability and headroom. | Consume meaningful quota. |

`RateLimitSignal` carries at minimum: whether the account is limited now, the reported reset
instant (if any), and per-window utilization (if any). `HealthProbe` carries reachability plus
the same utilization shape, so `quota-aware` routing has one thing to read.

**One driver is not HTTP.** `anthropic-oauth` satisfies the same interface, but its transport is
an SDK subprocess rather than a fetch: `resolveBaseUrl` and `buildHeaders` are inert for it, and
`parseRateLimit` reads SDK stream events instead of response headers. The interface holds because
everything routing cares about — model mapping, rate-limit signals, health — is transport-agnostic.

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
| Reconnect | re-runs the same CLI login against the same directory, preserving id, pool membership, and usage history |
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

The header rules for any Anthropic-dialect HTTP request (`anthropic-api`, `anthropic-compatible`,
z.ai / Kimi / MiniMax on their Anthropic surfaces) are verified and not up for reinterpretation:

| Credential | Headers |
|---|---|
| API key | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| OAuth / subscription token | `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` + `anthropic-version: 2023-06-01` |

`anthropic-version: 2023-06-01` is **always** required. An OAuth token on `x-api-key` **does not
work**, and a Bearer token without the `oauth-2025-04-20` beta header does not either —
converting between the two forms is a header change, not a key swap. The router does not emit
Bearer-token Anthropic requests for Claude subscriptions (those go through the SDK), but the rule
stands for any operator-supplied Account that carries such a token.

## `openai-oauth` — ChatGPT/Codex subscription

| Constant | Value |
|---|---|
| Flow | OAuth 2.0 authorization code + PKCE (S256) |
| Issuer | `https://auth.openai.com` |
| Client id | `app_EMoamEEZ73f0CkXaXp7hrann` (pinned; matches the first-party client) |
| Scope | `openid profile email offline_access` |
| Authorize | `<issuer>/oauth/authorize` |
| Token | `<issuer>/oauth/token` |
| Code exchange | `grant_type=authorization_code` + `code`, `redirect_uri`, `client_id`, `code_verifier` (form-encoded) |
| Refresh | `grant_type=refresh_token` + `refresh_token`, `client_id` — **JSON body**, not form-encoded |
| Base URL | `https://chatgpt.com/backend-api/codex` |
| Auth header | `Authorization: Bearer <access_token>` |
| Required header | `chatgpt-account-id: <account id>` |

`offline_access` is what earns the refresh token; without it the account degrades to
`needs_reauth` at first expiry. The account id is **derived, not configured** — decoded from
the `id_token` claims (falling back to the `access_token` claims), then stored on the Account
and sent on every request. Deriving it wrong produces upstream 401/403s that look like a bad
token, so it is captured once at connect time and re-derived on every refresh.

## API-key providers — z.ai, Kimi, MiniMax, OpenRouter

No refresh, no expiry, no OAuth state. An Account is a base URL, a key, and an alias map.
Valid until revoked upstream; a 401 moves the Account to `disabled`, not `needs_reauth`.

These are the **prepaid-balance** providers, so their drivers carry the other half of the job:
recognizing an out-of-credits response — each words it differently — and reporting it as
`exhausted` rather than a cooldown, because no clock refills a dead balance. See
[05-routing-and-failover.md](05-routing-and-failover.md).

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
| `sonnet` | *no entry* | `sonnet`, unchanged |

Rules:

- The map is **per Account**, not per Provider — two z.ai keys may map differently.
- **No entry means passthrough.** The router never guesses a substitute, and never fails a
  request because a name is unmapped; the upstream's own error is the honest answer.
- An Account's alias map also defines "supports the requested model" for candidate filtering
  when the Account declares an explicit model set. See [05-routing-and-failover.md](05-routing-and-failover.md).
- Aliasing is a name swap only. It never rewrites the body — that is
  [06-protocol-translation.md](06-protocol-translation.md)'s job.

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

1. Add one file under `providers/<id>.ts` implementing `ProviderDriver`.
2. Pin its constants at the top of that file — base URL, client id, scopes, required headers —
   each with a provenance comment.
3. Add its id to the `ProviderId` union in `packages/core`.
4. Register the driver in the registry map.
5. Add unit tests for `mapModelAlias`, `buildHeaders`, and `parseRateLimit` — all pure.
6. Ship. Routing, keys, pools, usage, and the admin UI need no changes.

That is the Open/Closed rule from [01-architecture.md](01-architecture.md) in practice: adding a
provider touches one new file plus two registration lines, and nothing else.

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
