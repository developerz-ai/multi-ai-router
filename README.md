<h1 align="center">multi-ai-router</h1>

<p align="center"><strong>your tools → multi-ai-router → providers</strong></p>

## What is this?

A server you run yourself, sitting between your AI tools and the companies you buy AI from. It speaks the OpenAI and Anthropic APIs, so the tools you already have do not change.

You already pay for the accounts — a few Claude subscriptions, an OpenAI key, maybe a ChatGPT plan and something cheaper for bulk work. Right now each one is pasted into a different tool on a different laptop, and only the person holding it can use it. Here you add them once, in a web console, and hand out keys of your own making instead. Your team's tools point at your server, the real logins never leave it, and each provider sees one caller instead of a dozen.

**Several accounts of the same kind is the normal case here, not a corner case.** Five Claude plans side by side should behave like one plan that rarely runs out. That is what this is for, and everything else in it exists to make that true.

```
Claude Code / OpenCode / Codex / any OpenAI|Anthropic client
        │  (router-issued API key)
        ▼
   multi-ai-router  ── selects account from the key's pool, injects the real
        │              upstream credential, refreshes OAuth, records usage
        ▼
Claude Max sub · ChatGPT sub · Anthropic API · OpenRouter · z.ai · Kimi · …
```

## Why it exists

**You bought five subscriptions and can still only use one at a time.** Every AI plan has a ceiling — so many messages in five hours, so many in a week. Hit it and you stop, even when the four other plans your team pays for are sitting idle. Someone has to notice, log out, log into another account, reconfigure their editor, and lose their place. The router makes that switch itself, on the failing request, before the tool notices anything went wrong — as long as the answer had not already started coming back.

**Every tool wants the real password.** Editors, agents, CI jobs, one-off scripts — each one asks for the provider credential, and each copy is another place you have to trust and eventually rotate. Here every person and every bot gets a key you minted, which reaches only the accounts you allowed and can be switched off on its own. The real credential never leaves your server: provider keys and tokens are encrypted in its database, and a Claude subscription's login stays in a private directory the router guards as the secret it is, because Anthropic's own tooling owns that file.

**Nobody knows who spent what.** Providers bill you in one lump. The router records every upstream attempt it makes — who sent it, which account served it, which model, how many tokens, how long it took, and what it cost. That last one is an estimate: prices come from a table the image ships and you can edit, so the figure tracks published rates rather than your invoice, a subscription's usage is valued the same way and reported separately instead of being mixed into real spend, and where a provider publishes no price the router reports no cost at all rather than a zero. Under a flood the reporting queue sheds its oldest records instead of slowing a request, and counts what it dropped. "Why was last month expensive" becomes a question with an answer.

## How you use it

**As a developer**, you change two settings in the tool you already use: the address it talks to, and the key it presents. It makes no difference whether that tool speaks OpenAI's API or Anthropic's — the router answers both, and translates between them when the account that serves you speaks the other one — refusing outright, rather than approximating, the handful of requests that will not convert cleanly. Two endpoints do need a matching account rather than a translated one, token counting and embeddings, and they say so plainly when none is in reach instead of guessing a number. That aside, this is the whole integration: no library to install, nothing in your code to change. Ask for the model you always ask for and you get that model — the router never swaps in a cheaper one, and the only thing that can rename it is an alias map you wrote yourself on the account. It is served by whichever account was healthy at that moment; if one is rate-limited or out of credit, the next one picks the request up, as long as no part of the answer has arrived yet. You never hold a real provider credential.

**As an admin** — there is one admin identity, pinned to a single email address, with one exception named below — you bring up the router and its database from the bundled Docker Compose file, open the console, and add your accounts — pasting in an API key, or signing in to a subscription through that provider's own login page. Group the accounts into pools, choose how each pool shares work, and mint a named key per person or per agent, each one limited to the accounts you pick, with its own request-rate ceiling and expiry date. The dashboard answers the daily questions: who spent what, which accounts are paused and when they come back, and which ones have run out of credit and need a human.

One thing to know before you start: the console has no password of its own. You sign in through an identity provider you point it at — Zitadel, Keycloak, Authentik, Auth0, or anything else that follows the standard — and the router refuses to start until one is configured. That is a deliberate trade: the sign-in guarding your console is then your identity provider's, with its multi-factor and its audit trail behind it, and trying this out on a bare laptop takes an identity provider first.

And the exception to "one admin", stated properly because it is the one that matters: you can enable a static token for scripts and recovery, and it is a **second full-admin credential**, not a lesser one. It reaches the whole admin plane, including reading a key back out. It has no email pin, no expiry and no rate limit, and the only way to revoke it is to change the value and restart the router. Leave it unset — the default — and the single-admin claim holds exactly; set it, and its secrecy is the only thing standing in front of every account in your deployment.

> **In one sentence:** a server you host that turns all the AI accounts you already pay for into a single address your whole team can use, without ever handing anyone the real logins.

---

## 🏛️ Four pillars

| Pillar | What it means |
|---|---|
| 🏊 **Pooling is the product** | Several accounts of the same kind behind one endpoint, with load balancing, failover, and quota awareness across them. |
| 🎯 **The client picks the model, the router picks the account** | Model names pass through unchanged. No semantic routing, no "cheapest model for this prompt" logic. |
| 🔐 **Upstream credentials never leave the router** | Encrypted at rest with AES-256-GCM. No endpoint returns an upstream credential, a refresh token, or an OAuth code. |
| 🔑 **One named, revocable key per human or agent** | Every key has a name, a scope (all accounts, some pools, or an explicit account list), its own rate limit and expiry — and its own usage and cost line. |

---

## 🛡️ Claude subscriptions run through the Claude Agent SDK

The single most important architectural decision here. Requests to a Claude Max/Pro **subscription** go through [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)'s `query()` — the documented, first-party programmatic entry point. **No OAuth token is extracted, no request is forged against `api.anthropic.com` with a borrowed subscription token, no binary is patched.** Anthropic keeps control of authentication, prompt caching, context management, compaction, and rate limiting, because the router depends on their mechanisms instead of routing around them.

Why: a router that makes a team's subscriptions usable only works if the accounts survive. Each Claude subscription Account owns an isolated **`CLAUDE_CONFIG_DIR`**, so N subscriptions coexist with no cross-contamination, and the `claude` CLI ships in the image. The costs are real and we take them anyway: a subprocess per request, and protocol re-synthesis back into Anthropic/OpenAI wire format. Quota signals come from the SDK's own `rate_limit_event` stream events, which feed `quota-aware` routing and the circuit breaker.

**Anthropic *API keys* are unaffected** — a plain key over plain HTTP to `api.anthropic.com` is ordinary, sanctioned API usage and takes the normal HTTP driver. Only subscriptions take the SDK path. Details: [`docs/idea/11-anthropic-agent-sdk.md`](docs/idea/11-anthropic-agent-sdk.md).

---

## ✨ What's in the box

Marked ⏳ where the design is settled but the code is not — see [Status](#-status).

- 🔀 **Two ingress dialects** — `POST /v1/messages` (Anthropic Messages), `POST /v1/chat/completions` and `POST /v1/responses` (OpenAI), `GET /v1/models` scoped to the presenting key, plus `POST /v1/messages/count_tokens` so Claude Code can size its context before a turn and `POST /v1/embeddings` so a RAG toolchain indexes through the same endpoint it chats through.
- 🔁 **Passthrough first** — same-dialect requests swap headers and forward the body byte-for-byte, streaming included. Cross-dialect translation is implemented for every crossing between the three dialects (Anthropic, OpenAI Chat Completions, OpenAI Responses), including streaming and tool calls; its lossy edges are documented and a request that cannot be translated faithfully is refused with a `400` naming the reason, rather than approximated.
- 🧩 **Subscriptions as first-class upstreams** — Claude subscriptions via the Agent SDK (a `CLAUDE_CONFIG_DIR` per account), ChatGPT/Codex via OAuth + PKCE, connected from the admin UI by redirect capture *or* manual code paste, with background refresh ahead of expiry for both.
- ⚖️ **Six load-balancing policies per pool** — sticky, round-robin, weighted, least-used, priority-failover, quota-aware — plus an optional overflow member (one of the pool's own accounts, held back until every other one is spent), bounded failover, and a circuit breaker.
- 🔑 **Named, retrievable keys with full or limited scope** — every key has a human-chosen name and a scope: `all` accounts, one or more pools, or an explicit account list. Stored encrypted, not hashed, so you can look a key up again without rotating it. A per-key rate limit is enforced on the request path.
- 📊 **Usage** — one record per upstream **attempt** (key, account, pool, session, model, tokens, cost, latency, TTFB, router overhead, outcome), queued in memory and batch-written off the request path, and read back by the console over any window, broken down by key, account, pool or model — with daily rollups behind it, cost estimation from an operator-editable price table, and a Prometheus `/metrics` exposition in front.
- ⏱️ **Reset visibility** — every unavailable account shows its reset as an absolute time *and* a countdown, per window for Claude subs (5-hour, 7-day, per-model), labeled as reported / estimated / unknown. Plus a manual **Re-check now**, per account or for all: providers sometimes reset early or lift a limit for everyone, and the router shouldn't sit on a stale timestamp.
- ⚡ **Performance as a stated goal** — under 5 ms added p99 on the passthrough path and zero added time-to-first-token. Streams are never buffered, passthrough bodies are never parsed, and nothing touches Postgres on the critical path: accounts and pools are read from a warm catalog, keys from a bounded cache, usage is written off-path. `bin/bench` checks both claims against a stub upstream and exits non-zero when either breaks; CI runs it and reports the delta against a committed baseline on every PR, but the job is `continue-on-error` — a shared runner's noise isn't a regression signal worth blocking a merge over, so it doesn't fail the build (yet).
- 🖥️ **SolidJS operator console** — overview, accounts, pools, keys, usage and settings all render live data: key reveal with no shown-once flow, destructive actions that name exactly what they break, reset shown as absolute time *and* countdown labelled by how far it can be trusted, a red banner for any account out of credits, a live request feed that names the failing request by id, account and error class, and a settings screen with live price overrides, retention knobs, scheduled-task health, and the audit feed.
- 🐳 **`docker compose up -d`** — the router plus PostgreSQL 16, a healthcheck gating startup, generic OIDC settings and one encryption key in `.env`.

---

## 🎯 Who this is for

- **Small teams** sharing a handful of paid subscriptions instead of buying one seat per developer.
- **Fleets of AI agents** that need a stable endpoint and a revocable key each, without a credential on every box.
- **Anyone who wants accounting** — per-key and per-account usage, tokens, and cost, in one place.

Not for you if you want a semantic model picker, an agent framework, multi-tenant SaaS, or a response cache. See [`docs/idea/00-overview.md`](docs/idea/00-overview.md) for the full non-goals.

---

## 🚀 Quick start

Configure one OIDC client and one encryption key, then start the stack. The bundled [`docker-compose.yml`](docker-compose.yml) brings up two services — the router and PostgreSQL 16 — with a healthcheck gating the router's start and `DATABASE_URL` wired in for you; it reads its secrets from `.env`, which is gitignored:

```bash
cp .env.example .env
# Edit .env: set the ADMIN_OIDC_* values and ENCRYPTION_KEY.
# Register the exact callback URI shown in .env.example at your IdP.

docker compose up -d
```

The admin console uses generic OIDC discovery, PKCE, and signed ID-token verification. Zitadel is production-tested; Keycloak, Authentik, and Auth0 use the same config-only contract. See [`docs/idea/13-admin-oidc.md`](docs/idea/13-admin-oidc.md) for client registration, claim requirements, and troubleshooting.

Migrations run at boot, are idempotent, and fail the boot loudly rather than starting on a half-migrated schema. Pointing `DATABASE_URL` at an existing or managed Postgres and dropping the bundled `postgres` service is a one-line change — see [`docs/idea/09-deployment.md`](docs/idea/09-deployment.md#using-an-existing-or-managed-postgres). The compose file itself is the reference, not a copy of it here: it's commented inline, and a snippet reproduced in docs would just be one more place for the two to drift apart.

Then open **<http://localhost:8080>** and select **Sign in with SSO**. For a plain-HTTP LAN install, set `SESSION_COOKIE_INSECURE=true`; otherwise terminate HTTPS in front so the hardened session cookie is accepted. The router process serves the SolidJS console itself, at the same origin as the API — no second container, no static host, no CORS to configure. An empty deployment lands on a three-step walk — **add an account → pool it → mint a key** — and the mint hands you a **Point your tool at it** block already filled in with this deployment's base URL and that key's real value, one tab per client. `/api/admin/**` is there directly if you'd rather script it. **Give the key a name; you can view and copy its value again at any time** via `POST /api/admin/keys/:id/reveal` — keys are stored encrypted, not hashed, because an operator running a fleet of agents needs to look one up later without rotating it.

| Env var | Required | Notes |
|---|---|---|
| `ADMIN_OIDC_ISSUER_URL` | ✅ | Exact OIDC issuer; discovery document `issuer` must match. |
| `ADMIN_OIDC_CLIENT_ID` | ✅ | OIDC client id and expected ID-token audience. |
| `ADMIN_OIDC_CLIENT_SECRET` | ✅* | Confidential-client secret. The shipped setup uses a confidential client; omit only for an explicitly configured public client. PKCE remains mandatory. |
| `ADMIN_OIDC_REDIRECT_URI` | ✅ | Exact registered callback: `/api/admin/auth/oidc/callback`. |
| `ADMIN_OIDC_ADMIN_EMAIL` | ✅ | Single allowed admin email; the IdP must assert it as verified in the ID token. |
| `ADMIN_OIDC_ADMIN_SUBJECT`, `ADMIN_OIDC_SCOPES`, `ADMIN_OIDC_CLOCK_SKEW_SECONDS` | — | Optional stricter `sub` pin, scopes, and clock-skew tolerance. |
| `ADMIN_API_TOKEN` | — | Break-glass bearer for scripts and recovery; separate from browser OIDC. |
| `ENCRYPTION_KEY` | ✅ | 32 bytes, base64. Boot fails loudly if missing or short. Encrypts upstream credentials and router keys. |
| `DATABASE_URL` | ✅ | PostgreSQL 16+ connection string. Supplied by the bundled compose file, so you don't set it by hand. |
| `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `PUBLIC_URL` | — | `PUBLIC_URL` is the router's own public address: the provider-account OAuth callback base, and the base URL the console fills into every client snippet. Set it when the console's own origin is not what an agent machine should call — a port-forward, a tunnel, a private hostname. Falls back to that origin. |
| `ADMIN_SESSION_*`, `ADMIN_LOGIN_*` | — | Session idle/absolute windows and callback-throttle limits. |
| `CATALOG_REFRESH_SECONDS`, `KEY_CACHE_*`, `USAGE_*` | — | The request path's staleness and memory bounds. Nothing there queries Postgres, so these decide how fast it learns about a change. |
| `RETENTION_*`, `JANITOR_INTERVAL_MINUTES`, `CLAUDE_CONFIG_ROOT`, `ACCOUNT_RECHECK_COOLDOWN_SECONDS` | — | Retention windows and background-work knobs. Every one is config, never a constant. |

Env is validated by Zod at boot; a bad config exits non-zero naming the offending variable. Run HTTPS in front — cookies are `Secure` by default. Full matrix in [`docs/idea/09-deployment.md`](docs/idea/09-deployment.md).

---

## 🚧 Status

**Every milestone in the roadmap has shipped: the admin API, the full data plane (same-dialect
passthrough, cross-dialect translation, and the Claude Agent SDK path), and the operator console are
all live.** The table is honest rather than aspirational — every declared provider has a driver, and
the one deliberate scope line (Gemini's *native* GenAI dialect, as opposed to its OpenAI-compatible
one) is named explicitly rather than silently approximated.

| Capability | State |
|---|---|
| Boot: Zod-validated env, migrations before the listener opens, `/healthz` + `/readyz` | ✅ |
| Admin auth: generic OIDC + PKCE, signed ID-token verification, single-principal pin, bounded session + CSRF | ✅ |
| Admin API: accounts, pools (incl. overflow account), keys, provider registry | ✅ |
| Router keys: minted, named, encrypted, **retrievable** (`POST /api/admin/keys/:id/reveal`), revocable | ✅ |
| Data plane, **same-dialect passthrough**: `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/models` | ✅ |
| `POST /v1/messages/count_tokens` — routed, scoped and failed over like any request | ✅ passthrough to an Anthropic-dialect account, or a `503` naming why none can count; never an estimate |
| `POST /v1/embeddings` — routed, scoped and failed over like any request | ✅ passthrough to an OpenAI-dialect account (either surface), or a `503` naming why none can embed; never another model's vectors |
| Routing: scope intersection, the six policies, overflow, bounded failover, circuit breaker | ✅ |
| Warm routing catalog + off-path batched `UsageRecord` writer | ✅ |
| HTTP provider drivers: Anthropic API, OpenAI API, ChatGPT/Codex OAuth, OpenRouter, z.ai, Kimi, MiniMax, Gemini, Groq, DeepSeek, xAI, Mistral, Together, Cerebras, and the two compatible escape hatches | ✅ |
| **Cross-dialect translation** — every crossing between `anthropic`, `openai-chat`, `openai-responses`, request/response/streaming, tool calls included | ✅ an untranslatable request is refused with a `400` naming the reason |
| **Claude subscriptions via the Agent SDK** | ✅ `anthropic-oauth` accounts are served — login, per-account `CLAUDE_CONFIG_DIR`, sessions, quota, tool passthrough, SDK-output re-synthesis |
| **ChatGPT/Codex OAuth** | ✅ authorization code + PKCE, redirect *and* paste capture, and background token refresh ahead of expiry |
| **Gemini native GenAI dialect** | ⏳ deliberately deferred — the `gemini` driver ships and serves Google's OpenAI-compatibility surface; the native protocol would be a fourth dialect in the translation matrix |
| **Operator console screens** — overview, accounts, pools, keys, usage | ✅ live data end to end, including a live request feed: the last N upstream attempts with outcome, account, model and latency, so "why did my request fail" is answerable without a log tail |
| **Operator console** — settings | ✅ session, provider registry, price overrides, retention knobs, scheduled-task health, and the audit feed are all live |
| Background tasks: janitor/retention sweeps, usage rollups, OAuth-state purge, quota floor — in-process timers, one advisory lock per task | ✅ |
| **`/metrics`** | ✅ Prometheus exposition, token-gated when `METRICS_TOKEN` is set |
| **Admin API without a browser** | ✅ set `ADMIN_API_TOKEN` and every `/api/admin/**` route takes `Authorization: Bearer …` — accounts, pools, keys, usage, settings, all scriptable. Unset leaves the plane browser-only |
| **Cost estimation and per-key rate-limit enforcement** | ✅ operator-editable price table plus a per-key sliding-window limiter on the request path |

The contract is [`docs/idea/`](docs/idea/): entity names, endpoints, policies, env vars, and invariants
described there are what gets built, and are the reference for any implementation work. Sections below
describing an unbuilt capability are marked. Track progress in
[`docs/idea/10-roadmap.md`](docs/idea/10-roadmap.md).

### Working on it

`bin/` is the interface — three commands are the whole contract:

```bash
bin/setup     # fresh clone: prereqs, install, .env with a generated ENCRYPTION_KEY + DATABASE_URL, dev Postgres, migrate
bin/dev       # each session: API + web, watch mode
bin/check     # before committing: lint, typecheck, test, build — the CI job list, in order
```

`bin/check` needs a database and refuses to start without one, because CI's test job has a real
Postgres 16 and the migration, advisory-lock, retention and readiness-probe suites gate themselves on
`DATABASE_URL`. Without it they skip, `bun test` folds the skips into the same green summary as a
pass, and the gate goes green having proved less than the PR will. `bin/setup` writes the dev
`DATABASE_URL` into `.env`, which is all it takes. A bare `bin/test` still runs on a machine with no
Docker — it just names, after the summary, the files that did not run.

The refusal is decided **inside** the test process, not by the shell that starts it, because the two
do not read the same files: `bun test` always loads `.env.test` and never loads `.env.local`, while
every other `bun` invocation does the opposite. A `DATABASE_URL` blanked in `.env.test` — or present
only in `.env.local` — is not the value the run sees, and a gate that checked the wrong one would
wave through exactly the silent skip it exists to stop. `bin/lib/database-url` prints the value the
run will use if you ever need to see it.

One more when you touch the request path: `bin/bench` drives the real router against an in-process
stub upstream and reports what its own `router_overhead_seconds` histogram recorded, plus added
time-to-first-token measured separately. It exits non-zero when either half of the budget breaks —
overhead p99 over `--budget-ms`, or added TTFT p95 over `--ttft-budget-ms`.

---

## 🔌 Pointing your client at it

Router keys are accepted in both dialects: `Authorization: Bearer mar_live_…` and `x-api-key: mar_live_…`. Anything that can set a base URL and a key works; the table below is what the console's own client snippets cover today — there's no automated integration test against each of these clients, so treat it as a documented, not verified, list.

**The console says all of this too, filled in.** Mint or reveal a key and the dialog carries a **Point your tool at it** panel — tabs for Claude Code, Cursor, Codex CLI, Aider, the OpenAI SDKs and `curl`, each block already containing this deployment's base URL (`PUBLIC_URL`, else the console's own origin) and that key's real value. [`docs/clients.md`](docs/clients.md) is the same content for someone who never opened the console.

| Client | How you point it at the router |
|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| **OpenCode** | Provider entry with the router's base URL + key, in either dialect |
| **Codex CLI** | `model_provider` entry in `~/.codex/config.toml` with `base_url` + env key |
| **Cursor** | Settings → Models → **Override OpenAI Base URL** = `https://router.example.com/v1` (the `/v1` suffix is required — Cursor appends `/chat/completions`), then paste the router key into the "OpenAI API Key" field. Agent and plan mode route through the override; **tab-autocomplete and inline-edit stay on Cursor's own backend** and never reach the router. |
| **Cline / Roo Code** | "OpenAI Compatible" provider, base URL + key — or the `settings.json` block below |
| **Aider** | `OPENAI_API_BASE` / `ANTHROPIC_API_BASE` + key |
| **OpenAI SDK (Python / Node)** | Construct the client with `base_url`/`baseURL` pointed at the router instead of `api.openai.com` |
| **LangChain** | `ChatOpenAI`/`ChatAnthropic` constructor, same `base_url` override |
| **LiteLLM** | `api_base` on the model entry in `config.yaml`, or `LITELLM_PROXY_API_BASE` if you're chaining proxies |

```bash
# Claude Code, or anything reading the Anthropic env vars
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_AUTH_TOKEN="mar_live_…"

# any OpenAI-compatible client — note the /v1 suffix
export OPENAI_BASE_URL="http://localhost:8080/v1"
export OPENAI_API_KEY="mar_live_…"
```

**Verify it landed on the router, not the real upstream**, before wiring in a real workload — a `200` with a list you recognize (or an empty `data: []` from an account that hasn't declared a catalog) is the router; a DNS error or a TLS handshake to a provider's real hostname means the base URL never took:

```bash
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .
```

**Config-file snippets for Codex CLI, Cline/Roo Code, the OpenAI SDKs, LangChain and LiteLLM live in [`docs/clients.md`](docs/clients.md)**, along with the per-client verification commands and the note on declaring an account's model catalog so a model picker isn't empty.

Send whatever model name you normally send. It passes through unchanged unless the selected account defines an alias map. Details in [`docs/idea/06-protocol-translation.md`](docs/idea/06-protocol-translation.md).

**Cross-dialect translation is live** — an Anthropic-dialect client can reach an OpenAI-dialect account and back, including streaming and tool calls. The one exception is a request shape that cannot be translated faithfully (a lossy edge documented in [`docs/idea/06-protocol-translation.md`](docs/idea/06-protocol-translation.md)): that fails with a `400` naming the reason rather than being converted approximately.

---

## 🌐 Supported providers

Each provider is a code-defined driver behind one interface. Adding one touches **one new driver
file plus two registration lines** (the `ProviderId` union in `packages/core`, the entry in
`providers/registry.ts`) — not the single file the phrase suggests. See
[`docs/idea/03-providers.md#adding-a-provider`](docs/idea/03-providers.md#adding-a-provider) for
why the extra two lines are load-bearing rather than boilerplate.

The registry is a **total** record, so every provider id is either a driver or a recorded reason it is not — never silently absent, never stubbed into something that looks like it works.

| Provider | Auth | Driver | Notes |
|---|---|---|---|
| `anthropic-api` | API key, `x-api-key` | ✅ | Anthropic platform key, plain HTTP to `api.anthropic.com` (+ `anthropic-version: 2023-06-01`). No refresh. A spent balance arrives as a **`400`**, so the driver classifies on the message. |
| `openai-api` | API key, `Bearer` | ✅ | OpenAI platform key; Chat Completions and Responses surfaces. A spent balance arrives as a **`429`**, so the driver classifies on `insufficient_quota` rather than the status. |
| `openrouter` | API key, `Bearer` | ✅ | Aggregator; namespaced model ids, so an alias map is usually needed. |
| `zai` | API key, `Bearer` | ✅ | Two surfaces (Anthropic **or** OpenAI); the account picks one. Alias map typically needed. |
| `kimi` | API key, `Bearer` | ✅ | Anthropic-shaped. Alias map typically needed. **Not `x-api-key`.** |
| `minimax` | API key, `Bearer` | ✅ | Anthropic-shaped, and reports some failures in a `base_resp` envelope on an HTTP `200`. |
| `groq` | API key, `Bearer` | ✅ | GroqCloud. Its `error.type` names the *limit* that was hit, not the error kind, so classification keys on `code`; a spend limit is a **`400 blocked_api_access`**, and `498` (flex-tier capacity) fails over instead of failing the request. |
| `deepseek` | API key, `Bearer` | ✅ | The one vendor whose statuses mean what they say — a spent balance is a real **`402`**. Its `type`/`code` are inverted, so the driver reads neither. |
| `xai` | API key, `Bearer` | ✅ | Grok. Two error shapes, one flat with an English sentence in `code`. xAI publishes no status for a depleted balance, so the driver encodes no guess. |
| `mistral` | API key, `Bearer` | ✅ | **Error body has no `error` wrapper.** Keys on the four published `type` categories, never on `code` (a numeric string). "Service tier capacity exceeded" is a cooldown, not a billing stop. |
| `together` | API key, `Bearer` | ✅ | **`403` means the prompt exceeded the context length**, not a rejected key — so an oversized request never flags the credential. `503` is the platform's capacity, `429` your dynamic rate, `402` the monthly spend cap. |
| `cerebras` | API key, `Bearer` | ✅ | Shares Mistral's unwrapped error envelope. A spent free-tier **day** is a `429` that refills on a clock, never `exhausted`. |
| `ollama` | **None** (key optional) | ✅ | A local or self-hosted Ollama on its OpenAI-compatible surface. The one provider that authenticates nobody: an account may be created with **no credential at all**, and one supplied is sent as `Bearer` for the same endpoint behind a proxy. Operator-supplied base URL — inside a container `localhost` is the router itself. |
| `openai-compatible` | API key, `Bearer` | ✅ | Any third-party OpenAI-shaped endpoint. Operator-supplied base URL. |
| `anthropic-compatible` | API key | ✅ | Any third-party Anthropic-shaped endpoint. Keeps Anthropic's own header rules. |
| `anthropic-oauth` | Claude Agent SDK | ✅ | Claude Max/Pro subscription. Login and credential refresh run through the `claude` CLI into a per-account `CLAUDE_CONFIG_DIR`; the router never mints or stores a subscription token. Requests are served through `@anthropic-ai/claude-agent-sdk`'s `query()`, with session stickiness, quota from SDK `rate_limit_event`s, tool passthrough, and SDK-output re-synthesized back into Anthropic (and, via translation, OpenAI) wire format. |
| `openai-oauth` | OAuth + PKCE | ✅ | ChatGPT/Codex subscription via `auth.openai.com`, `offline_access` scope, `chatgpt-account-id` derived from the token claims. An account is created with no credential, connected through `POST /:id/connect` by redirect or paste capture, and refreshed in the background ahead of expiry — a failed refresh parks it at `needs_reauth` rather than failing a request. |
| `gemini` | API key, `Bearer` | ✅ | Google's **OpenAI-compatibility** surface (`generativelanguage.googleapis.com/v1beta/openai`) — chat, embeddings and the model listing. Failures come back as canonical gRPC statuses, and `RESOURCE_EXHAUSTED` is a **cooldown**, not a dead balance, even though its message names billing. The retry delay rides `error.details[].RetryInfo`, since Gemini sends no rate-limit headers. Native GenAI dialect deliberately deferred. |

**z.ai, Kimi, and MiniMax take their key as `Authorization: Bearer`, never `x-api-key`** — they share the Anthropic *dialect*, not its auth scheme, and they must not receive the Anthropic OAuth beta header either.

Per-provider constants, endpoints, and scopes: [`docs/idea/03-providers.md`](docs/idea/03-providers.md).

---

## ⚖️ Load-balancing policies

Selection is filter → policy → failover. The filter keeps accounts in the key's pool that are `active`, not cooling down, not out of credits, and that support the requested model. The candidate set is **always** the intersection of the pool's members and the presenting key's scope — a key never reaches an account outside its scope, whatever the policy would prefer, and an empty candidate set fails with an error naming the reason instead of silently widening.

| Policy | Behavior | Use it when |
|---|---|---|
| `sticky` **(default)** | Rendezvous hashing on the session key. Deterministic, survives restarts, reshuffles only the sessions of an added/removed account. | Always, unless you have a reason not to — prompt caching is per-account, so a hopping session pays a cold cache every hop. |
| `round-robin` | Even spread, ignores session affinity. | Uniform accounts, short requests. |
| `weighted` | Round-robin biased by per-account `weight`. | Accounts with unequal capacity. |
| `least-used` | Fewest in-flight requests, or lowest recent token spend. | Bursty, long-running requests. |
| `priority-failover` | Strict order; descends only when the higher account is unavailable. | Burn the subscription first, fall back to the paid API. |
| `quota-aware` | Prefers the account with the most remaining headroom, using live quota signals where exposed. | Several subscriptions with hard reset windows. |

On `429`, a drained balance, `5xx`, or a connection failure, the router retries the next candidate — bounded, and only while nothing has been streamed to the client yet. See [`docs/idea/05-routing-and-failover.md`](docs/idea/05-routing-and-failover.md).

### Running out: two different failures, never conflated

| Condition | Meaning | Status | Recovery |
|---|---|---|---|
| **Rate limited / quota window hit** | Temporary. A subscription's 5-hour or 7-day window is spent; it refills on a clock. | `cooling_down` | Automatic at the reported reset time (exponential backoff when none is reported); a half-open probe confirms. |
| **Out of credits / balance exhausted** | Hard stop. A prepaid balance hit zero, a plan expired, or billing failed. No clock will fix it. | `exhausted` | **Human action only** — top up, fix billing, replace the key. Never retried on a timer. |

An `exhausted` account leaves every candidate set immediately and gets a red banner on the dashboard, not a status buried on a detail page: it silently shrinks the pool. When every candidate is unavailable the router says which condition it hit — "all 4 accounts in pool `team` are rate limited, earliest reset 14:32Z" — and maps it to a distinct code: rate-limited → **`429`** with `Retry-After`, exhausted or billing → **`402`**, nothing in scope → **`403`**. Never a generic `500`, never a silent fallback outside the key's scope.

---

## 📊 Usage & cost

The recurring operator question is "who burned what", and the console answers it without a query.

- **Totals per key** — lifetime and windowed (today / 7d / 30d / custom): requests, input and output tokens, cache read/write tokens where reported, estimated cost, error rate, p50/p95 latency. The `/keys` list carries a live total per row; the detail page breaks it down.
- **The same totals per account, per pool, and per model**, over the same windows, plus per-account subscription headroom remaining in the current window.
- **Charts** — request and token/cost time series stacked by key or account, per-account quota-utilization gauges, top-N leaderboards (keys by spend, models by volume), inline sparklines in the keys and accounts tables.
- Aggregates read rolled-up daily rows, not raw records, so the dashboard stays fast after rollup. Failover means one client request can emit several records, one per upstream attempt, joined by a correlation id — the UI labels which number is the request and which is the attempt.

Cache-aware by design: total prompt size is the sum of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` — reporting `input_tokens` alone badly under-reports cached traffic.

Cost comes from a price table shipped with the image and overridable per provider + model in the console. Twelve vendor tables cover fourteen providers — Anthropic, OpenAI, Google, z.ai, Kimi, MiniMax, Groq, DeepSeek, xAI, Mistral, Together, Cerebras — and the table carries the date its rows were last checked, so a number nobody can date is never mistaken for a current one. Four providers ship no price on purpose (OpenRouter prices per route, Ollama is your own hardware, and the two `*-compatible` escape hatches are your own contract), and an unpriced request reports **no cost rather than a zero** — a zero in a spend column is the claim that a request was free. Each account is marked `metered` or `subscription`; a subscription's usage is valued at the vendor's public API rate and reported as a **separate, notional** total, never summed with real spend. See [`docs/idea/08-observability.md`](docs/idea/08-observability.md).

---

## 📚 Docs

| Doc | What's in it |
|---|---|
| [`docs/idea/00-overview.md`](docs/idea/00-overview.md) | What it is, who it's for, non-goals |
| [`docs/idea/01-architecture.md`](docs/idea/01-architecture.md) | Repo layout, module boundaries, SRP rules |
| [`docs/idea/02-domain-model.md`](docs/idea/02-domain-model.md) | Provider, Account, Pool, ApiKey, Session, UsageRecord, AuditEvent |
| [`docs/idea/03-providers.md`](docs/idea/03-providers.md) | Provider registry, driver interface, per-provider constants |
| [`docs/idea/04-api-keys-and-access.md`](docs/idea/04-api-keys-and-access.md) | Key minting, encryption, full vs. limited scope, pool binding, admin auth |
| [`docs/idea/05-routing-and-failover.md`](docs/idea/05-routing-and-failover.md) | Filter → policy → failover, circuit breaker, stickiness |
| [`docs/idea/06-protocol-translation.md`](docs/idea/06-protocol-translation.md) | Ingress × egress matrix, streaming, tool calls, model aliases |
| [`docs/idea/07-security.md`](docs/idea/07-security.md) | Encryption at rest, redaction, rate limits, threat surface |
| [`docs/idea/08-observability.md`](docs/idea/08-observability.md) | Usage records, cost estimation, metrics, logs, health |
| [`docs/idea/09-deployment.md`](docs/idea/09-deployment.md) | Env reference, compose, image tags, retention knobs |
| [`docs/idea/09-deployment.md#troubleshooting`](docs/idea/09-deployment.md#troubleshooting) | Symptom → cause → fix runbook: boot failures, stuck accounts, OAuth callbacks, `401`s, stale sweeps, and more |
| [`docs/idea/10-roadmap.md`](docs/idea/10-roadmap.md) | Milestones M1–M8 and what's deferred |
| [`docs/idea/11-anthropic-agent-sdk.md`](docs/idea/11-anthropic-agent-sdk.md) | Claude subscriptions via the Agent SDK: `query()`, per-account `CLAUDE_CONFIG_DIR`, quota events, costs |
| [`docs/clients.md`](docs/clients.md) | Client cookbook: config-file snippets per tool, and the `curl` that proves the base URL took |
| [`docs/reusable-code.md`](docs/reusable-code.md) | Shared helpers, services, and components that already exist — and where a new shared thing belongs |
| [`SECURITY.md`](SECURITY.md) | Supported versions, private vulnerability reporting, response SLA, scope |

---

## 🧱 Stack

| Concern | Choice |
|---|---|
| Runtime | Bun 1.3+ |
| Language | TypeScript, strict, no `any` |
| HTTP | Hono |
| Validation | Zod at every external boundary |
| ORM | Drizzle |
| Database | PostgreSQL 16+ via `postgres.js` — concurrent writers, real transactions, JSONB for provider-shaped payloads, and a path to a managed/HA instance |
| Claude subscriptions | `@anthropic-ai/claude-agent-sdk` + the `claude` CLI in the image, one `CLAUDE_CONFIG_DIR` per account |
| Frontend | SolidJS + Vite SPA, `@solidjs/router`, SCSS modules, TanStack Solid Query |
| Lint/format | Biome |
| Tests | `bun test` — unit (pure) + integration (HTTP, mocked upstreams) |
| CI | GitHub Actions on Blacksmith runners |
| Distribution | Multi-arch image — `ghcr.io/developerz-ai/multi-ai-router`, published only on a `v*` release tag, plus a Postgres service in the bundled compose file |

---

## ⚠️ Framing

The router moves your own accounts through your own server. Claude subscriptions go through the first-party Claude Agent SDK — documented calls, no token extraction, no forged requests — a deliberate account-safety decision. Other subscription flows (ChatGPT/Codex) are reverse-engineered from the official clients and can break when a provider changes them. Check your providers' terms for shared and programmatic access.

---

## 📜 License

MIT. See [`LICENSE`](LICENSE).
