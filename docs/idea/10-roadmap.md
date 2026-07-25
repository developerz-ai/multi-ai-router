# Roadmap

Status: **M1 through M8 are all done.** The capability table in the [README](../../README.md#-status)
is the authoritative statement of what runs today; this page is the order the work happened in and
what remains genuinely open (see [Open questions](#open-questions) below — those are design
uncertainties, not missing code).

## Milestones

Sequential in intent, though M5 landed ahead of M4 — pools and routing needed no subscription
account to be correct, and the Agent-SDK path was the hardest milestone rather than the next one.
Each shipped on its own.

| Milestone | State |
|---|---|
| M1 Skeleton · M2 Accounts · M3 Data plane passthrough · M5 Pools & load balancing | done |
| M4 Claude subscriptions via the Agent SDK · M4b ChatGPT/Codex · M6 Translation · M7 Admin UI · M8 Ops | done |

| Milestone | Scope | Done when |
|---|---|---|
| **M1 — Skeleton** | Hono server, Zod-validated env, PostgreSQL 16 + Drizzle (postgres.js), idempotent migrations at boot, single-admin login, `/healthz` + `/readyz` | `docker compose up -d` brings up the router and Postgres, the operator sets three env vars by hand, an admin can log in, and health endpoints answer truthfully. A failed migration fails the boot instead of serving a half-migrated schema. |
| **M2 — Accounts** | Provider registry, API-key accounts, AES-256-GCM encryption at rest, admin CRUD | Several accounts of the same provider can be added, labeled, and edited; no endpoint returns a credential; credentials survive a restart. |
| **M3 — Data plane passthrough** | `POST /v1/messages`, `POST /v1/chat/completions`, same-dialect passthrough, router-key auth in both header styles, `UsageRecord` per request | Claude Code and an OpenAI-compatible client both work end to end against a real upstream, streaming included, with usage rows landing. |
| **M4 — Claude subscriptions via the Agent SDK** | The `claude` CLI in the image, one `CLAUDE_CONFIG_DIR` provisioned per Account on a persistent volume, CLI-driven login with paste-back capture from the admin UI, requests served through `@anthropic-ai/claude-agent-sdk`'s `query()`, SDK output re-synthesized into Anthropic and OpenAI wire format, `rate_limit_event` quota ingestion, `needs_reauth` on failure. **This is the hardest milestone — scope it as such.** Nothing here is a proxy hop: it is a subprocess, a config directory, and a protocol rebuilt from a different shape. | A Claude Max subscription can be connected from the UI, several subs coexist with no cross-contamination, a streaming Claude request through the SDK is indistinguishable on the wire from a passthrough one, quota events drive `cooling_down`, and a broken login lands in `needs_reauth` (not a 500). |
| **M4b — ChatGPT/Codex subscriptions** | Authorization-code + PKCE against `auth.openai.com`, both capture modes, background refresh ahead of expiry, `needs_reauth` | A ChatGPT subscription can be connected from the UI and keeps working across token expiry unattended. |
| **M5 — Pools & load balancing** | Pools, all six policies, session affinity, bounded failover, circuit breaker, `cooling_down` vs `exhausted` as distinct outcomes, reset visibility (per-window, labeled reported/estimated/unknown) and the manual re-check probe | Traffic spreads across a pool per policy; a session sticks to its account; a rate-limited account cools down, shows when it returns, and is skipped; an out-of-credits account is surfaced loudly and never retried on a timer; **Re-check now** returns a recovered account to `active` immediately. |
| **M6 — Translation** | Cross-dialect conversion including streaming SSE, tool/function calls, system prompts, stop reasons, usage fields | An Anthropic-dialect client reaches an OpenAI-dialect account (and the reverse) with tool calls and streaming intact; known lossy edges are documented and tested. |
| **M7 — Admin UI** | SolidJS SPA, overview, accounts, pools, keys, usage totals and charts, the reset/health surface (per-window countdowns, `exhausted` banner, **Re-check now**), settings | The whole operator experience is the browser — no config file, no CLI, no DB surgery. "When does it come back?" and "is it back yet?" are both answerable without reading logs. |
| **M8 — Ops** | Janitor + retention sweeps, `/metrics` including `router_overhead_seconds`, cost table, per-key rate limits | The DB stops growing without bound, Prometheus scrapes cleanly, the router's own added latency is measured next to upstream latency, and spend is attributable per key and per account. |

## Deferred

Named, with the reason. Not "someday" — a deliberate not-now.

| Deferred | Reason |
|---|---|
| **Multi-user / RBAC** | Single admin, single org is a non-goal boundary, not an oversight. Users, roles, and org hierarchy change the auth model, the audit model, and the UI at once. |
| **Subprocess pooling for the Agent-SDK path** | Claude subscriptions spawn a `claude` subprocess per request (M4). Reusing or pooling those processes is the obvious optimization and the obvious correctness hazard: sessions, config directories, and cancellation all become shared state, and the SDK's own lifecycle assumptions decide whether it is safe at all. **Measure first** — the ceiling is unknown, and tuning against a guess is how you get a cross-account leak. |
| **BullMQ + Dragonfly job queue** | The house default for background jobs, and a decision on record rather than an omission. Background work here is small, periodic, and idempotent — sweeps, rollups, a state purge — with no fan-out, no user-submitted work, and no dead-letter needs. A broker means a third container, a third failure mode, and a third thing to back up, in a product whose install is three env vars and `docker compose up`. In-process jittered timers plus a Postgres advisory lock per task give the same guarantees for free ([01-architecture.md](01-architecture.md#background-work-and-scheduling)). **Revisit only if a genuinely queue-shaped workload appears** — per-request async work, user-triggered long jobs, or fan-out across many workers. |
| **Per-key spend budgets** | Needs a trusted cost model first. Cost estimation lands in M8 from a static price table; enforcing money against an estimate is worse than not enforcing it. |
| **Webhooks** | No consumer yet. Account health changes are visible in the UI and on `/metrics`; a push channel is speculative until someone needs one. |
| **Response caching** | Explicit non-goal for v1. Prompt caching is the upstream's job and is per-account — which is exactly why routing is sticky by default. |
| **OAuth encryption-key rotation** | Rotating `ENCRYPTION_KEY` means re-encrypting every stored OAuth credential in place, online, with a rollback that survives a crash mid-rotation — a migration with a live data plane on top of it. Worth doing; not worth doing before the credentials it protects exist in the field. (The reverse-engineered client ids are a separate matter and are handled by editing one provider file — see Maintenance posture.) |
| **Chart library choice** | The usage data shape is specified; the renderer is not. Picking a charting library before the dashboard's real queries exist is a bet placed blind. |
| **Gemini native dialect** | v1 reaches Gemini through its OpenAI-compatibility layer. A native Google GenAI driver is a third dialect in the translation matrix and must wait until the two-dialect matrix is solid. |
| **Admin TOTP (`ADMIN_TOTP_SECRET`)** | The admin plane is not meant to be publicly exposed. Second-factor on a single env-configured account is worth doing, but after the planes it protects exist. |

## Maintenance posture

**Claude subscriptions are not part of this problem** — they run through the Claude Agent SDK and the
`claude` CLI's own login, which is a documented, first-party entry point (M4). Nothing is
reverse-engineered there, and account safety is exactly why.

The **non-Anthropic** subscription flows (ChatGPT/Codex today) are **reverse-engineered from the
official first-party clients**. Their client ids, scopes, endpoints, and required headers are not a
published contract. **They will drift.** Design for that instead of pretending otherwise.

| Principle | What it means in practice |
|---|---|
| **One file per provider** | A provider changing its flow touches exactly one file in `providers/`. Nothing in routing, translation, or the admin plane knows a provider-specific constant. |
| **Constants are annotated** | Every pinned value carries a comment recording where it came from and what breaks if the provider changes it. A constant with no provenance is a future outage with no lead. |
| **Breakage is visible, not silent** | A refresh that stops working moves the account to `needs_reauth` and surfaces it on `/accounts`. The account is excluded from routing rather than failing requests. Clients see traffic shift to healthy accounts, not a 500. |
| **Health probes catch drift early** | Per-account health checks fail before a user does, so a broken provider shows as a red account and a `/readyz` signal rather than as a support question. |
| **Reconnect is the fix path** | When a flow changes, the operator's remedy is one button that re-runs the current flow against the existing row — id, pool membership, and usage history preserved. |

Detail: [03-providers.md](03-providers.md) for the per-provider constants,
[09-deployment.md](09-deployment.md) for the operator-facing symptoms.

## Open questions

Genuinely unsettled. Listed so they are not mistaken for decided.

- **The Agent-SDK path's concurrency ceiling.** Claude subscription requests are one `claude`
  subprocess each. How many concurrent ones does a normal box actually sustain — tens, or low
  hundreds? Where does it break first: memory, process table, file descriptors, or the provider's
  own per-account limits? Until that number is measured, the router has no principled place to set a
  concurrency cap, and an unbounded subprocess count is the failure mode.
- **Per-request memory cost of an SDK subprocess.** Everything else in the router scales with
  concurrent streams at roughly a socket and a buffer each; this one path scales with resident
  memory per in-flight request. What is the real figure, how much of it is fixed startup versus
  context size, and does it grow with a long conversation? The sizing guidance in
  [09-deployment.md](09-deployment.md) is deliberately shaped around "budget one subprocess per
  concurrent Claude request" precisely because the constant is not yet known — and it is also what
  decides whether pooling is worth its hazards.
- **Is advisory-lock leader election enough at multi-replica scale?** Each periodic task takes a
  Postgres advisory lock, so exactly one replica runs a given sweep and the rest skip. That is
  correct and nearly free at two or three replicas. Unsettled at more: a session-scoped lock is
  released on disconnect, so a replica that hangs without dropping its connection blocks the task
  until it dies, and a replica killed mid-sweep leaves a `ScheduledTaskRun` row open with no
  liveness signal behind it. Does that need a lock timeout, a heartbeat on the run row, or does the
  jittered next tick simply pick it up? Also unknown: whether the skipping replicas' lock attempts
  stay negligible as the task list grows. See
  [01-architecture.md](01-architecture.md#background-work-and-scheduling).
- **Cost attribution for subscription accounts.** A Claude Max request has no per-request price.
  Do we report a notional cost using the API price table, report tokens only, or model a
  subscription's amortized cost per token? Each answer makes the dashboard mean something
  different.
- **Sticky sessions across restarts.** Rendezvous hashing is deterministic, so affinity survives a
  restart for an unchanged account set — but the session *identity* (fingerprint → session id) is
  in-memory. Should that map be persisted, or is a cold prompt cache after a restart acceptable?
- **Per-key rate limits: tokens or requests?** Requests per window is simple and useless against a
  single enormous prompt. Tokens per window is meaningful but is only known after the upstream
  answers. Which one, or both?
- **Quota headroom for providers that report nothing.** Claude subscriptions expose usage signals;
  most API providers expose only response rate-limit headers, and some expose nothing. What does
  `quota-aware` do with an account whose headroom is unknowable — treat it as full, as empty, or
  exclude it from the policy?
- **What counts as one session for attribution.** Client-supplied header, else a fingerprint of the
  first user message plus working directory. How does that behave for an agent fleet that shares a
  working directory, or for a client that sends no header and reuses a prompt prefix?
- **Failover after a partial stream.** Once bytes are on the wire the request fails honestly — but
  a failure at the first token is indistinguishable in shape from one at the last. Is there a safe
  early-stream window where a retry is still correct?
- **Usage roll-up granularity.** Daily aggregates keep the DB small but flatten the "requests per
  minute" view older than the raw window. Is hourly retention needed in between?

## Read next

| Doc | Covers |
|---|---|
| [00-overview.md](00-overview.md) | What the product is and is not |
| [03-providers.md](03-providers.md) | The reverse-engineered flows this posture is about |
| [09-deployment.md](09-deployment.md) | Env reference, retention knobs, image tags, troubleshooting |
