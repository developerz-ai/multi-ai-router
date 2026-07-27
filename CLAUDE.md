# CLAUDE.md

Self-hosted API router. A team of developers and AI agents shares one pool of AI subscriptions and API keys behind a single endpoint, speaking the OpenAI or Anthropic wire protocol. Upstream credentials never leave the router.

Pooling is the product: **many Accounts of the same Provider is the normal case** (five Claude subs side by side). Nothing in the schema, UI, or routing may assume one account per provider.

Full data plane shipped: accounts, pools, keys, `/v1/messages` + `/v1/chat/completions` + `/v1/responses`, cross-dialect translation, Claude subscriptions via the Agent SDK, ChatGPT/Codex OAuth, admin CRUD, 11 migrations, and a complete SolidJS operator console. See `docs/idea/10-roadmap.md` for per-milestone state. Spec: `docs/idea/`. Behavior change → update the spec in the same PR. Shared code inventory: `docs/reusable-code.md`.

## Response Rules

- Execute. No preamble. No "I'll start by…". No restating the task.
- Lead with action or answer. Reasoning after, only if non-obvious.
- Parallel tool calls when independent.
- Read before speculating.
- Disagree when user is wrong. State the correction.
- Terse. Fragments OK. Drop articles, filler, hedging.
- Code/commands/paths: verbatim. Only prose gets compressed.
- End-of-turn summary: 1–2 sentences. Nothing else.

## Non-negotiables (MUST)

1. **Claude subscriptions go through the Claude Agent SDK.** `@anthropic-ai/claude-agent-sdk`'s `query()`, one `CLAUDE_CONFIG_DIR` per Account, the `claude` CLI in the image. NEVER extract a subscription OAuth token, forge a request at `api.anthropic.com` with one, or patch a binary. Account safety is the reason; a subprocess per request plus protocol re-synthesis is the price, and we pay it. Anthropic **API keys** are a different path: plain HTTP, normal driver.
2. **The SDK never executes a tool on this host. Passthrough-only, allowlisted by name.** The Agent SDK's built-ins (`bash`, `read`, `write`, `edit`, `glob`, `grep`, …) run *on the router*, so leaving them reachable is arbitrary command execution for anyone holding any router key — `ENCRYPTION_KEY`, the Postgres credentials, every Account's `CLAUDE_CONFIG_DIR`. Disable them with an **explicit allowlist that names the permitted tools** — never a blocklist, never a default. Tool calls are forwarded to the **client** to execute; the client owns the user's filesystem, which is what a router should do anyway. Launch with `settingSources: []` explicitly (omitting it slurps the host's `CLAUDE.md` and settings into the prompt — a cross-tenant leak, not clutter) and strip inherited `ANTHROPIC_*` env. **A test asserting a host-tool invocation is rejected is a security regression gate** — it fails the build; never skip, quarantine, or relax it. Rationale: `docs/idea/07-security.md`.
3. Upstream credentials never leave the router. Not in responses, logs, errors, admin endpoints. Encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`). The log redactor is tested.
4. **The client picks the model. The router picks the account.** Never re-route a model, never substitute a cheaper one. Model names pass through unchanged except through an Account's explicit alias map.
5. Router keys are **named and retrievable** — stored encrypted (AES-256-GCM, same `ENCRYPTION_KEY`), not hashed; verification decrypts by indexed prefix and compares in constant time. The admin can view and copy a key any time. No "shown once" flow anywhere in UI or docs.
6. **Key scope is enforced as an intersection.** Scope is `all` | pools | explicit account list. Candidates = pool members ∩ key scope, always. Empty set → a specific error naming why. Never widen.
7. **`cooling_down` ≠ `exhausted`.** Rate limited / window spent is temporary and clock-recoverable → `429` + `Retry-After`. Out of credits / billing dead is permanent until a human acts → `402`; never retried on a timer. Nothing in scope → `403`. Never a generic `500`.
8. **Overhead is a budget: <5 ms added p99, zero added time-to-first-token.** Never buffer a stream. Never parse a passthrough body. Nothing touches Postgres on the critical path — warm in-memory caches, single indexed query on miss. Usage writes batch off-path. Connections pooled and warm. `router_overhead_seconds` is a first-class metric; a regression in it is a bug. The Agent-SDK path is the labeled exception.
9. Routing selection, protocol translation, quota math are **pure functions**. Clocks, stores, health snapshots injected. No mocks needed to test them.
10. Same-dialect requests are byte-passthrough — headers swapped, body untouched, streaming forwarded byte-for-byte. Translate only across dialects.
11. Every retention window is config, not a constant in code. Same for intervals and limits.
12. Adding a provider touches exactly one file in `providers/`. Anything else changing means the interface is wrong.
13. **Background work is in-process + Postgres advisory locks. No broker.** Jittered interval timers, `pg_try_advisory_lock` per task so exactly one replica runs a sweep, every task idempotent/resumable/bounded-batch, last run + outcome written to `ScheduledTaskRun` so a wedged task is visible. BullMQ/Dragonfly is deliberately deferred — don't reinstate it. **Credential refresh is expiry-driven and single-flighted per account, never a poll**; a failed refresh means `needs_reauth`, not a failed request. **Claude sub tokens are never touched by us** — the Agent SDK refreshes them inside the Account's `CLAUDE_CONFIG_DIR`; we only notice auth failure and mark `needs_reauth`. Rationale: `docs/idea/01-architecture.md`.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Bun 1.3+ |
| Language | TypeScript strict, no `any` |
| HTTP | Hono |
| Validation | Zod at every external boundary (requests, env, provider responses) |
| ORM | Drizzle |
| Database | PostgreSQL 16+ via `postgres.js` (not node-postgres) |
| Claude subscriptions | `@anthropic-ai/claude-agent-sdk` — the `claude` CLI ships in the image; one `CLAUDE_CONFIG_DIR` per Account on a persistent volume |
| Frontend | SolidJS + Vite SPA, `@solidjs/router`, SCSS modules + CSS custom properties |
| Server state | TanStack Solid Query |
| Lint/format | Biome |
| Tests | `bun test` — unit (pure, no I/O) + integration (HTTP + mocked upstreams) |
| CI | GitHub Actions on Blacksmith runners |
| Distribution | `ghcr.io/developerz-ai/multi-ai-router`, multi-arch. **Images publish only on a `v*` tag** (`release.yml`); pushes to `main` run the quality gate and publish nothing. `docker compose up -d` starts router + Postgres 16, healthcheck gating the router |

Postgres is the house standard and the current decision — earlier drafts said SQLite; **any doc still saying SQLite, single-file DB, or `DATABASE_PATH` is stale, fix it.** Migrations run at boot, idempotent, and fail the boot rather than start half-migrated. `DATABASE_URL` ships in the bundled compose file so the operator still sets three env vars by hand.

## Commands

`bin/` is the interface. Never write an ad-hoc invocation where a wrapper exists, and never document a raw command in its place — if something is worth running twice, it belongs in `bin/`.

**Fresh clone: `bin/setup`** (prereqs → install → `.env` with a generated `ENCRYPTION_KEY` and the dev `DATABASE_URL` → dev Postgres → migrate). Then `bin/dev` each session, `bin/check` before committing. Those three are the house contract and mean this repo behaves like every other one.

| Task | Command |
|---|---|
| Local dev (API + web, watch) | `bin/dev` |
| Full test (unit + integration) | `bin/test` |
| Single test by pattern | `bun test <pattern>` |
| Lint and typecheck only | `bin/lint` |
| Format | `bin/fmt` |
| Fresh clone → running stack | `bin/setup` |
| The gate (lint + typecheck + test + build), before committing | `bin/check` — refuses to run without a `DATABASE_URL`, so it can never pass on fewer tests than CI |
| Overhead budget: p50/p95/p99 + added TTFT vs a stub upstream | `bin/bench` |
| Before cutting a tag: the tree agrees on one version, and the tag names it | `bin/verify-version` · `bin/verify-version v1.0.0` — `release.yml` runs the same check before it builds a layer |
| Dev database shell / migrate / reset | `bin/db psql` · `bin/db migrate` · `bin/db reset` |
| Build release image locally | `docker build -t multi-ai-router:dev .` |

Local config: copy `.env.example` → `.env`. `.env` is gitignored. Three env vars you set by hand — `ADMIN_USERNAME`, `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`), `ENCRYPTION_KEY` — plus `DATABASE_URL`, which the compose file supplies.

## Layers

One reason to change per layer. Don't blur.

| Layer | Owns | Module |
|---|---|---|
| Transport | Hono routes, middleware, SSE streaming, request size caps | `apps/api/src/routes/`, `apps/api/src/middleware/` |
| Auth | Admin session cookie + CSRF; router key verification | `apps/api/src/services/admin-auth/`, `apps/api/src/services/dataplane/auth/` |
| Routing | Filter → policy → failover chain, health state, circuit breaker | `apps/api/src/services/routing/` |
| Providers | Per-upstream drivers, OAuth flows, pinned constants | `apps/api/src/providers/` |
| Claude SDK | Agent SDK `query()` calls, per-Account `CLAUDE_CONFIG_DIR` lifecycle, `rate_limit_event` → quota state, SDK-output → wire-format re-synthesis | `apps/api/src/providers/claude-sdk/` |
| Translation | Ingress dialect × egress dialect conversion, streaming, tool calls | `apps/api/src/services/translate/` |
| Usage | UsageRecord writes, cost estimation, rollups | `apps/api/src/usage/` |
| Scheduler | Every periodic task — jittered in-process timers, `pg_try_advisory_lock` per task, `ScheduledTaskRun` last-run records. Retention sweeps (the janitor) are one task among several: usage rollup, OAuth-state purge, quota floor | `apps/api/src/scheduler/` |
| DB | Drizzle schema, migrations, repositories | `packages/db/` |
| Config | Zod env schema, boot validation, shared types + errors | `packages/core/` |
| Web | SolidJS admin SPA | `apps/web/` |

Files ≤300 LOC. Split by responsibility, not by size.

## Conventions

The bar: idiomatic, boring, readable TypeScript. A function reads top to bottom without chasing state. Equally-correct options → pick the one easier to delete.

- Thin routes, fat services. A route does: parse → validate → call one service → render. Zero business logic in a handler.
- One module, one reason to change. `services/<domain>/<verb>.ts` — `services/key/minter.ts`, `services/account/refresher.ts`.
- Custom error classes, never generic. `RouterError` base → `NoHealthyAccountError`, `QuotaExhaustedError`, `UpstreamTimeoutError`, `KeyRevokedError`, `CredentialDecryptError`. Each maps to one stable HTTP code.
- Zod at every boundary: client requests, env, provider responses. Validate into a type once at the edge; don't re-validate downstream.
- No `any`. No non-null `!` on unvalidated data. Biome is the floor, not the ceiling.
- Provider drivers behind one interface (Open/Closed). See non-negotiable 12.
- Repositories own SQL. Services never write queries inline.
- No premature abstraction. The **second** real implementation earns the interface. Concrete first.
- Same logic a second time → lift to a shared helper. Helpers stay SRP; no `utils` grab-bag.
- Structured JSON logs with a request id propagated end to end. No `console.log`.
- Comment the non-obvious *why*, never the *what*. Architecture decisions land in `docs/idea/`, not code comments.
- Never claim something is implemented. Nothing is.

## Testing

- **Unit** — pure logic: routing selection, translation, quota math, cost estimation, env validation. No mocks, no clock, no network. Inject the snapshot.
- **Integration** — booted server, real HTTP, **mocked upstreams**. Assert a `UsageRecord` row per request, including failures.
- NEVER hit a real provider in CI. No live OAuth, no live inference, no real credential in a fixture, no real `claude` CLI subprocess — the Agent SDK is stubbed at the `query()` boundary.
- Redaction is tested: assert no credential material appears in a log line or error body.

## Reverse-engineered flows

**Claude Max/Pro is NOT in this category** — its login runs through the Agent SDK / `claude` CLI into a per-Account `CLAUDE_CONFIG_DIR` (non-negotiable 1). Only non-Anthropic subscription flows (ChatGPT/Codex today) are reverse-engineered from the official first-party clients.

- Client ids, scopes, authorization/token endpoints, required headers: **pinned constants, one file per provider** in `providers/`.
- Each constant carries a comment recording provenance (where the value came from) and blast radius (what breaks if the provider changes it).
- Expect drift. A provider changing its flow must touch exactly one file.
- Both capture modes converge on the same server-side exchange: redirect callback and manual `code#state` paste. Manual paste is first-class, not a fallback. Claude subs use the same two-mode UI, but the exchange is handed to the CLI.
- `state` + PKCE `code_verifier` live server-side, one-shot, 10-minute TTL, bound to a pending account row. Mismatched or reused `state` → reject.

## Frontend

SolidJS SPA, `@solidjs/router`, TanStack Solid Query for server state. Vite build, static assets served by the same Hono process, same origin — no CORS.

- SCSS module per component (`Button.module.scss`). Tokens + mixins in a shared `styles/` entry. No global cascade beyond reset + tokens.
- CSS custom-property design tokens. **Semantic tokens only** (`--surface`, `--text-muted`, `--accent`, `--danger`). Never a raw hex in a component.
- Dark-first, light supported, one token set drives both.
- Density over decoration: operator console. Tables, sparklines, status dots. Data first, chrome second.
- Usage is a headline surface, not a tab afterthought: totals per key / account / pool / model, windowed (today / 7d / 30d / custom), charts, quota gauges, top-N, inline sparklines.
- Unavailable accounts show reset as absolute time **and** countdown, per window for Claude subs, labeled reported / estimated / unknown. `exhausted` shows "needs top-up", never a countdown. A manual **Re-check now** (per account and all-accounts) hits the same probe the half-open transition uses — one code path, server-side cooldown, last-checked timestamp always visible.
- `exhausted` accounts get a red dashboard banner, not a buried status.
- Destructive actions confirm and say exactly what breaks. Keys are named, listed, and their value is viewable/copyable any time — no "you will not see this again" warning.
- Keyboard reachable, focus-visible everywhere, `prefers-reduced-motion` honored.

## NEVER

- Extract a Claude subscription token, forge a request to `api.anthropic.com` with one, or patch the CLI. Subscriptions go through the SDK.
- Let the Agent SDK execute a tool on the router host, enable its internal-MCP execution mode, rely on a blocklist or a default instead of a named allowlist, or drop `settingSources: []`. Tool calls go to the client — see non-negotiable 2.
- Return an upstream credential, refresh token, or OAuth code in any response, log, or error. (Router keys are admin-retrievable by design — that is the one exception, and only on the authenticated admin plane.)
- Substitute, downgrade, or "optimize" the model the client asked for.
- Re-parse and re-serialize a same-dialect body, or buffer a stream before forwarding it.
- Put a Postgres query, a usage insert, or any blocking I/O on the request-critical path.
- Conflate rate-limited with out-of-credits, or retry an `exhausted` account on a timer.
- Retry a request onto another account after bytes are on the wire — fail honestly.
- Hard-code a retention window, TTL, or interval.
- Add Redis/Dragonfly, BullMQ, a worker container, or a cron entry for background work — see non-negotiable 13. Never schedule a refresh timer for a Claude subscription account.
- Hit a real provider from a test.
- Add multi-user, RBAC, billing, caching, or tool execution — see non-goals in `docs/idea/`.
- Force-push `main`. `--no-verify` on commits — fix the hook.

## Note

Do not use git worktrees — work directly in this checkout. If a task needs subagents, run them as a team here: split the work into disjoint pieces so no two agents touch the same files.
