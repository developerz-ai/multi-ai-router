# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.3] — 2026-07-28

### Fixed

- **The failed-test log recorded the router's own words, not the upstream's.**
  1.1.2 logged a failed "Test now", but logged the router-authored message — so
  an upstream failing for a reason this build has no rule for was recorded as
  "the Claude Agent SDK failed for a reason this router does not recognize". A
  tautology, and a dead end for whoever has to write the missing rule. The probe
  now carries the upstream's verbatim text through to the log line (never to the
  response body, which is a contract with the console).

## [1.1.2] — 2026-07-28

### Fixed

- **The quota reading "Test now" ingested never reached the console.** 1.1.1 folded
  the turn's `rate_limit_event` into the SDK quota store, but the console and
  routing both read a *health snapshot*, so the reading landed somewhere nothing
  renders and the windows stayed as stale as before. The resulting signal is now
  folded into the health store too — the same hop the dispatch path makes.
- **A failed "Test now" left no trace anywhere.** Its message is router-authored
  by design, so when an upstream fails for a reason this build has no rule for,
  the only copy of what it actually said was the one being discarded — a dead end
  for the operator and for whoever has to write the missing rule. A failed test
  now logs the provider, model and reason at `warn`.

## [1.1.1] — 2026-07-28

### Fixed

- **Every Claude subscription reset instant was being discarded.** The Agent SDK
  reports `rate_limit_info.resetsAt` in epoch **seconds** (verified live against
  SDK 0.3.220); the router read it as milliseconds, landing it in 1970, where it
  failed the "still in the future" check and was dropped as stale. That silently
  cost the whole subscription reset surface — no per-window countdown in the
  console, `resetSource: "unknown"` instead of `provider-reported`, and a circuit
  breaker estimating a backoff while holding the provider's exact answer. Both
  units are now accepted, so an SDK that switches to milliseconds cannot re-break
  it in the other direction.
- **"Test now" billed a turn and threw away the quota reading it paid for.** The
  SDK volunteers `rate_limit_event` on every query, not only near a limit. The
  probe ignored it, so an account's quota windows stayed empty until unrelated
  traffic happened to route through it — backwards for the one button whose job
  is answering "how is this account doing". The readings now land in the same
  store the dispatch path writes to.
- **A spent Claude subscription reported "the Claude Agent SDK turn did not
  succeed (success)".** That failure arrives as `subtype: "success"` with
  `is_error: true` and the reason in `result`; the probe rendered the subtype and
  discarded the reason. It now reads the stated reason through the same
  classification table the data plane uses, so a spent window says so.

## [1.1.0] — 2026-07-27

### Added

- `ADMIN_API_TOKEN` — a bearer credential for `/api/admin/**`, so the admin API
  can be driven by a script, a CI job, or an agent rather than only a browser
  session. Unset by default, which leaves the plane browser-only. Boot refuses a
  token under 32 characters (nothing rate-limits this credential the way the
  login form is throttled) or one wearing the `mar_live_` router-key prefix (the
  admin guard rejects that prefix outright, so it would authenticate nothing).
  Router keys still cannot reach the admin plane under any configuration.

### Fixed

- **Kimi: a spent billing cycle disabled the account permanently.** Kimi
  announces it as `403 permission_error`, which fell through to the status
  default `auth` — and an `api-key` account's auth failure parks at `disabled`,
  a state no timer lifts. An operator had to re-enable a credential that was
  never broken, for a quota Kimi refills on its own clock. Now classified
  `rate-limited` off the wording, so the genuine `permission_error` still reads
  as an auth failure.
- **z.ai: a spent weekly plan window was re-probed every five minutes.** z.ai
  reports the reset instant only inside the error message — no `retry-after`, no
  `x-ratelimit-*` — so the breaker fell back to its backoff, capped at five
  minutes, against a window with days left to run. The instant is now parsed and
  reported as `provider-reported`, and `1310` is pinned as its own signal.
- `GET /api/admin/auth/session` no longer risks a `RangeError` when rendering a
  session with no expiry.

## [1.0.0] — 2026-07-26

First stable release. Multi AI Router is a self-hosted proxy: point your tools
at one OpenAI/Anthropic-compatible endpoint, and it fans out across whatever
pool of provider accounts and API keys you've given it — several Claude
subscriptions side by side, a mix of OpenAI-compatible vendors, local Ollama —
picking a healthy account per request and failing over without you touching
your tooling config.

### Added

- Full data plane: `/v1/messages`, `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages/count_tokens`, `/v1/embeddings`, `GET /v1/models/:id` — with
  cross-dialect translation (OpenAI ⇄ Anthropic) for streaming and
  non-streaming requests alike.
- Claude Max/Pro/Team subscriptions as a first-class provider, driven through
  `@anthropic-ai/claude-agent-sdk` with one `CLAUDE_CONFIG_DIR` per account,
  an explicit tool allowlist, and passthrough-only tool execution on the
  client — the router never runs a tool on its own host.
- ChatGPT/Codex OAuth and 17 provider drivers total, including six
  OpenAI-shaped vendors, native Gemini over Google's OpenAI-compatible
  surface, and Ollama with optional (no-auth) local endpoints.
- Routing: filter → policy → failover chain, health snapshots, circuit
  breaker, `cooling_down` vs `exhausted` distinction (429+`Retry-After` vs
  402), per-account "Test now" real completion probe.
- Router keys: named, encrypted at rest, viewable/copyable any time (no
  "shown once" flow), scope enforced as pool-members ∩ key-scope, per-key
  rate limits.
- Admin plane: full CRUD for accounts, pools, and keys; OAuth connect flows
  for Claude subscriptions and ChatGPT/Codex; guided onboarding walk from
  zero accounts to a working key with copy-paste client snippets (Claude
  Code, Cursor, Codex CLI, Aider, OpenAI SDK, curl).
- Operator console (SolidJS SPA): usage totals per key/account/pool/model
  windowed today/7d/30d/custom, live request feed, quota gauges, top-N,
  inline sparklines, dark-first design tokens — served from the same origin
  as the API, no CORS.
- Scheduler: in-process jittered timers with `pg_try_advisory_lock` per task
  — usage rollup, OAuth-state purge, quota-floor recovery — every task
  idempotent, resumable, bounded-batch, with `ScheduledTaskRun` visibility.
  No broker, no cron, no refresh timer for Claude subscription tokens.
- 11 Drizzle migrations, Postgres 16+ via `postgres.js`.
- Observability: structured JSON logs with request-id propagation and a
  tested credential redactor, Prometheus-style `/metrics` including
  `router_overhead_seconds`, `/healthz` and `/readyz`.
- `bin/bench`: overhead-measurement harness (p50/p95/p99 + added
  time-to-first-token vs a stub upstream), wired as a non-blocking CI report
  against a committed baseline.
- Multi-arch (`amd64`/`arm64`) container image published to
  `ghcr.io/developerz-ai/multi-ai-router` on release tags, `docker compose up
  -d` starting router + Postgres with a health-gated startup.
- `SECURITY.md` with coordinated disclosure, `.github/SETTINGS.md` for
  repo-config guidance.

### Fixed

- **A recovering account now takes exactly one probe, not the whole backlog.**
  The circuit breaker's half-open state promised "one request through as a
  probe", but nothing admitted one: the reset instant passing made the account
  eligible to every waiting request at the same millisecond, so everything that
  queued up during a five-minute cooldown dispatched at it together and rate
  limited it again. One request is now admitted; the rest are dropped as
  `probe-in-flight` and answered `429` with the hold's expiry. The operator's
  **Re-check now** joins the same gate rather than adding a second recovery
  path.
- **`ROUTING_FAILURE_THRESHOLD`, `ROUTING_BASE_BACKOFF_MS`, and
  `ROUTING_MAX_BACKOFF_MS` now reach the breaker.** All three were parsed at
  boot, documented in the environment reference, and read by nothing — the
  breaker silently ran its module defaults. Backoff is also jittered now, so
  accounts tripped in the same second no longer return in the same millisecond
  and re-stampede whatever knocked them over. New `ROUTING_HALF_OPEN_HOLD_MS`
  bounds a probe that never reports.
- **A pool's overflow account can no longer sit outside the pool.** A key
  scoped to a pool used to reach that pool's overflow even when the account
  belonged to no pool the key names — spending it once every member cooled
  down, and advertising its models in `/v1/models`. Candidates are
  `pool_members ∩ key_scope` with no exception: the overflow is now one of the
  pool's own members, held back from the policy. The admin plane refuses a
  write that breaks the rule (`overflow_not_member`, `400`), including an edit
  that would drop the overflow's own membership; routing ignores a reference
  that predates it; migration `0010` backfills existing rows as memberships, so
  behavior is unchanged and the reach becomes visible in the pool's member
  list.
- A `<select>` in the console rendered its first option instead of the stored
  one — a pool on `round-robin` read as `sticky`, and one with an overflow read
  as "None".
- `router_overhead_seconds` no longer double-counts a successful attempt's
  own upstream wait time.
- Session-slide writes to the store throttled instead of firing on every
  request.
- Log redaction gaps closed for JWTs, connection strings, and vendor API
  keys, while still preserving diagnosable structure (host/path kept).
- SPA static-file serving hardened against path traversal, with the fallback
  route never shadowing a real, mounted API request.

### Documentation

- Full spec under `docs/idea/` (architecture, domain model, providers,
  routing/failover, protocol translation, security, observability,
  deployment, roadmap) reconciled against shipped behavior — no more "not
  implemented" framing for features that ship.
- README rewritten around the actual product story: your tools → Multi AI
  Router → providers.

[1.0.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v1.0.0
