<h1 align="center">multi-ai-router</h1>

**Self-hosted API router that lets a team of developers and AI agents share one pool of AI subscriptions and API keys behind a single endpoint.** 🔀

You log in as the single admin, attach upstream accounts (Claude Max/Pro OAuth, ChatGPT/Codex OAuth, Anthropic API, OpenAI API, OpenRouter, z.ai, Kimi, MiniMax, Gemini, or any OpenAI-/Anthropic-compatible endpoint), then mint API keys and bind each key to the accounts it may use. Clients — Claude Code, Cursor, OpenCode, Codex CLI, Cline, Aider, anything speaking the OpenAI or Anthropic wire protocol — point at the router with one of its keys. **The client picks the model. The router picks the account.**

**Pooling is the point.** Many accounts of the *same* provider is the normal case, not an edge case — five Claude Max subscriptions, three z.ai keys, two ChatGPT subs, side by side. A pool turns "my five Claude subs plus the OpenRouter key as a safety net" into one addressable thing a key points at, and makes it behave like a single, more reliable account than any of its members.

```
Claude Code / OpenCode / Codex / any OpenAI|Anthropic client
        │  (router-issued API key)
        ▼
   multi-ai-router  ── selects account from the key's pool, injects the real
        │              upstream credential, refreshes OAuth, records usage
        ▼
Claude Max sub · ChatGPT sub · Anthropic API · OpenRouter · z.ai · Kimi · …
```

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

- 🔀 **Two ingress dialects** — `POST /v1/messages` (Anthropic Messages), `POST /v1/chat/completions` and `POST /v1/responses` (OpenAI), `GET /v1/models` scoped to the presenting key.
- 🔁 **Passthrough first** — same-dialect requests swap headers and forward the body byte-for-byte, streaming included. ⏳ Cross-dialect translation is specified, its lossy edges documented, and currently **refused with a `400`** rather than approximated.
- 🧩 ⏳ **Subscriptions as first-class upstreams** — Claude subscriptions via the Agent SDK (a `CLAUDE_CONFIG_DIR` per account), ChatGPT/Codex via OAuth + PKCE, connected from the admin UI by redirect capture *or* manual code paste, with background refresh ahead of expiry.
- ⚖️ **Six load-balancing policies per pool** — sticky, round-robin, weighted, least-used, priority-failover, quota-aware — plus an optional overflow account, bounded failover, and a circuit breaker.
- 🔑 **Named, retrievable keys with full or limited scope** — every key has a human-chosen name and a scope: `all` accounts, one or more pools, or an explicit account list. Stored encrypted, not hashed, so you can look a key up again without rotating it.
- 📊 **Usage** — one record per upstream **attempt** (key, account, pool, session, model, tokens, cost, latency, TTFB, router overhead, outcome), queued in memory and batch-written off the request path. ⏳ Rollups, the usage screens, charts, and Prometheus `/metrics`.
- ⏱️ ⏳ **Reset visibility** — every unavailable account shows its reset as an absolute time *and* a countdown, per window for Claude subs (5-hour, 7-day, per-model), labeled as reported / estimated / unknown. Plus a manual **Re-check now**, per account or for all: providers sometimes reset early or lift a limit for everyone, and the router shouldn't sit on a stale timestamp.
- ⚡ **Performance as a stated goal** — under 5 ms added p99 on the passthrough path and zero added time-to-first-token. Streams are never buffered, passthrough bodies are never parsed, and nothing touches Postgres on the critical path: accounts and pools are read from a warm catalog, keys from a bounded cache, usage is written off-path.
- 🖥️ ⏳ **SolidJS operator console** — the shell, navigation, theming, and design system exist; the accounts, pools, keys, usage, and settings screens are placeholders over a working admin API.
- 🐳 **`docker compose up -d`** — the router plus PostgreSQL 16, a healthcheck gating startup, three env vars you set by hand.

---

## 🚧 Status

**The admin API and the same-dialect data plane work. Cross-dialect translation, the Claude Agent SDK
path, and the operator console's screens do not.** The table is honest rather than aspirational —
everything below that says "no" is refused explicitly, by name, and never silently approximated.

| Capability | State |
|---|---|
| Boot: Zod-validated env, migrations before the listener opens, `/healthz` + `/readyz` | ✅ |
| Admin auth: login, sliding session under an absolute cap, CSRF, login throttling | ✅ |
| Admin API: accounts, pools (incl. overflow account), keys, provider registry | ✅ |
| Router keys: minted, named, encrypted, **retrievable** (`POST /api/admin/keys/:id/reveal`), revocable | ✅ |
| Data plane, **same-dialect passthrough**: `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/models` | ✅ |
| Routing: scope intersection, the six policies, overflow, bounded failover, circuit breaker | ✅ |
| Warm routing catalog + off-path batched `UsageRecord` writer | ✅ |
| HTTP provider drivers: Anthropic API, OpenAI API, OpenRouter, z.ai, Kimi, MiniMax, and the two compatible escape hatches | ✅ |
| **Cross-dialect translation** — an Anthropic-dialect client reaching an OpenAI-dialect account | ❌ refused with a `400` naming the reason |
| **Claude subscriptions via the Agent SDK** | ❌ refused; `anthropic-oauth` accounts cannot be served |
| **ChatGPT/Codex OAuth, Gemini native** | ❌ no driver |
| **Operator console screens** — accounts, pools, keys, usage, settings | ❌ shell, navigation, and theming only; every screen is still a placeholder |
| **`/metrics`, the janitor and retention sweeps, usage rollups, per-key rate-limit enforcement** | ❌ not built |

The contract is [`docs/idea/`](docs/idea/): entity names, endpoints, policies, env vars, and invariants
described there are what gets built, and are the reference for any implementation work. Sections below
describing an unbuilt capability are marked. Track progress in
[`docs/idea/10-roadmap.md`](docs/idea/10-roadmap.md).

### Working on it

`bin/` is the interface — three commands are the whole contract:

```bash
bin/setup     # fresh clone: prereqs, install, .env with a generated ENCRYPTION_KEY, dev Postgres, migrate
bin/dev       # each session: API + web, watch mode
bin/check     # before committing: lint, typecheck, test — the CI job list, in order
```

---

## 🎯 Who this is for

- **Small teams** sharing a handful of paid subscriptions instead of buying one seat per developer.
- **Fleets of AI agents** that need a stable endpoint and a revocable key each, without a credential on every box.
- **Anyone who wants accounting** — per-key and per-account usage, tokens, and cost, in one place.

Not for you if you want a semantic model picker, an agent framework, multi-tenant SaaS, or a response cache. See [`docs/idea/00-overview.md`](docs/idea/00-overview.md) for the full non-goals.

---

## 🚀 Quick start

Three env vars you set by hand and one command. No hash-generation step. `docker compose up -d` brings up two services — the router and PostgreSQL 16 — with a healthcheck gating the router's start and `DATABASE_URL` wired in for you.

```yaml
# compose.yaml
services:
  router:
    image: ghcr.io/developerz-ai/multi-ai-router:latest
    ports: ["8080:8080"]
    environment:
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: change-me
      ENCRYPTION_KEY: REPLACE_ME     # 32 random bytes: openssl rand -base64 32
      DATABASE_URL: postgres://router:router@db:5432/router
    # per-Account CLAUDE_CONFIG_DIR — live credentials, treat as secret material
    volumes: ["claude-config:/data/claude"]
    depends_on: { db: { condition: service_healthy } }
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: router, POSTGRES_PASSWORD: router, POSTGRES_DB: router }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U router"], interval: 5s, retries: 10 }
    volumes: ["pgdata:/var/lib/postgresql/data"]
    restart: unless-stopped

volumes:
  pgdata:
  claude-config:
```

```bash
docker compose up -d
```

Migrations run at boot, are idempotent, and fail the boot loudly rather than starting on a half-migrated schema. Pointing `DATABASE_URL` at an existing or managed Postgres and dropping the bundled `db` service is a one-line change.

Then log in and add an account, a pool, and a key. **Today that means `/api/admin/**` directly** — the console's screens are still placeholders ([Status](#-status)). **Give the key a name; you can view and copy its value again at any time** via `POST /api/admin/keys/:id/reveal` — keys are stored encrypted, not hashed, because an operator running a fleet of agents needs to look one up later without rotating it.

| Env var | Required | Notes |
|---|---|---|
| `ADMIN_USERNAME` | ✅ | Single admin, no user table in v1. |
| `ADMIN_PASSWORD` | ✅ | Hashed with argon2id at boot, never persisted in plaintext. |
| `ADMIN_PASSWORD_HASH` | — | Pre-computed argon2id hash. Takes precedence over `ADMIN_PASSWORD`. Exactly one of the two must be set or boot fails. |
| `ENCRYPTION_KEY` | ✅ | 32 bytes, base64. Boot fails loudly if missing or short. Encrypts upstream credentials and router keys. |
| `DATABASE_URL` | ✅ | PostgreSQL 16+ connection string. Supplied by the bundled compose file, so you don't set it by hand. |
| `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `PUBLIC_URL` | — | `PUBLIC_URL` is the OAuth callback base — only needed for redirect capture. |
| `ADMIN_SESSION_*`, `ADMIN_LOGIN_*` | — | Session idle/absolute windows and login-throttle limits. |
| `CATALOG_REFRESH_SECONDS`, `KEY_CACHE_*`, `USAGE_*` | — | The request path's staleness and memory bounds. Nothing there queries Postgres, so these decide how fast it learns about a change. |
| `RETENTION_*`, `JANITOR_INTERVAL_MINUTES`, `CLAUDE_CONFIG_ROOT`, `ACCOUNT_RECHECK_COOLDOWN_SECONDS` | — | Retention windows and background-work knobs. Every one is config, never a constant. |

Env is validated by Zod at boot; a bad config exits non-zero naming the offending variable. Run HTTPS in front — cookies are always `Secure`. Full matrix in [`docs/idea/09-deployment.md`](docs/idea/09-deployment.md).

---

## 🔌 Pointing your client at it

Router keys are accepted in both dialects: `Authorization: Bearer mar_live_…` and `x-api-key: mar_live_…`. Anything that can set a base URL and a key works; these are the tested targets.

| Client | How you point it at the router |
|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| **OpenCode** | Provider entry with the router's base URL + key, in either dialect |
| **Codex CLI** | `model_provider` entry in `~/.codex/config.toml` with `base_url` + env key |
| **Cursor** | Settings → Models → **Override OpenAI Base URL** = `https://router.example.com/v1` (the `/v1` suffix is required — Cursor appends `/chat/completions`), then paste the router key into the "OpenAI API Key" field. Agent and plan mode route through the override; **tab-autocomplete and inline-edit stay on Cursor's own backend** and never reach the router. |
| **Cline / Roo Code** | "OpenAI Compatible" provider, base URL + key |
| **Aider** | `OPENAI_API_BASE` / `ANTHROPIC_API_BASE` + key |

```bash
# Claude Code, or anything reading the Anthropic env vars
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_AUTH_TOKEN="mar_live_…"

# any OpenAI-compatible client — note the /v1 suffix
export OPENAI_BASE_URL="http://localhost:8080/v1"
export OPENAI_API_KEY="mar_live_…"
```

Send whatever model name you normally send. It passes through unchanged unless the selected account defines an alias map. Details in [`docs/idea/06-protocol-translation.md`](docs/idea/06-protocol-translation.md).

**Until translation lands, a client can only reach accounts speaking its own dialect.** An Anthropic-dialect request routed to an OpenAI-dialect account fails with a `400` naming the reason, rather than being converted approximately — scope each key to accounts that match the client, or wait for M6.

---

## 🌐 Supported providers

Each provider is a code-defined driver behind one interface; adding one is a single new file.

The registry is a **total** record, so every provider id is either a driver or a recorded reason it is not — never silently absent, never stubbed into something that looks like it works.

| Provider | Auth | Driver | Notes |
|---|---|---|---|
| `anthropic-api` | API key, `x-api-key` | ✅ | Anthropic platform key, plain HTTP to `api.anthropic.com` (+ `anthropic-version: 2023-06-01`). No refresh. A spent balance arrives as a **`400`**, so the driver classifies on the message. |
| `openai-api` | API key, `Bearer` | ✅ | OpenAI platform key; Chat Completions and Responses surfaces. A spent balance arrives as a **`429`**, so the driver classifies on `insufficient_quota` rather than the status. |
| `openrouter` | API key, `Bearer` | ✅ | Aggregator; namespaced model ids, so an alias map is usually needed. |
| `zai` | API key, `Bearer` | ✅ | Two surfaces (Anthropic **or** OpenAI); the account picks one. Alias map typically needed. |
| `kimi` | API key, `Bearer` | ✅ | Anthropic-shaped. Alias map typically needed. **Not `x-api-key`.** |
| `minimax` | API key, `Bearer` | ✅ | Anthropic-shaped, and reports some failures in a `base_resp` envelope on an HTTP `200`. |
| `openai-compatible` | API key, `Bearer` | ✅ | Any third-party OpenAI-shaped endpoint. Operator-supplied base URL. |
| `anthropic-compatible` | API key | ✅ | Any third-party Anthropic-shaped endpoint. Keeps Anthropic's own header rules. |
| `anthropic-oauth` | Claude Agent SDK | ⏳ | Claude Max/Pro subscription. Login and credential refresh run through the `claude` CLI into a per-account `CLAUDE_CONFIG_DIR`; the router never mints or stores a subscription token. Quota from SDK `rate_limit_event`s. **Not served yet** — an account of this provider is refused by name. |
| `openai-oauth` | OAuth + PKCE | ⏳ | ChatGPT/Codex subscription via `auth.openai.com`, `offline_access` scope. |
| `gemini` | API key | ⏳ | Deferred in v1: reachable through `openai-compatible`; native endpoint constants are not pinned. |

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

On `429`, `5xx`, or a connection failure, the router retries the next candidate — bounded, and only while nothing has been streamed to the client yet. See [`docs/idea/05-routing-and-failover.md`](docs/idea/05-routing-and-failover.md).

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

Cache-aware by design: total prompt size is the sum of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` — reporting `input_tokens` alone badly under-reports cached traffic. Cost comes from a static, user-overridable price table. See [`docs/idea/08-observability.md`](docs/idea/08-observability.md).

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
| [`docs/idea/10-roadmap.md`](docs/idea/10-roadmap.md) | Milestones M1–M8 and what's deferred |
| [`docs/idea/11-anthropic-agent-sdk.md`](docs/idea/11-anthropic-agent-sdk.md) | Claude subscriptions via the Agent SDK: `query()`, per-account `CLAUDE_CONFIG_DIR`, quota events, costs |
| [`docs/reusable-code.md`](docs/reusable-code.md) | Shared helpers, services, and components that already exist — and where a new shared thing belongs |

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
