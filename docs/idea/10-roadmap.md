# Roadmap

Status: **M1 through M8 are all done.** The capability table in the [README](../../README.md#-status)
is the authoritative statement of what runs today; this page is the order the work happened in, what
has been [decided](#decided), and what remains genuinely open (see
[Open questions](#open-questions) below — those are design uncertainties, not missing code).

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
| **M7 — Admin UI** | SolidJS SPA, overview, accounts, pools, keys, usage totals and charts, the reset/health surface (per-window countdowns, `exhausted` banner, **Re-check now**, **Test now**, **Discover models**), settings | The whole operator experience is the browser — no config file, no CLI, no DB surgery. "When does it come back?" and "is it back yet?" are both answerable without reading logs, "does this credential actually work?" is one confirmed button press away, and "what does this account serve?" is one free one. |
| **M8 — Ops** | Janitor + retention sweeps, `/metrics` including `router_overhead_seconds`, `bin/bench` to reproduce the overhead budget on demand, cost table, per-key rate limits | The DB stops growing without bound, Prometheus scrapes cleanly, the router's own added latency is measured next to upstream latency and can be re-measured by anyone in one command, and spend is attributable per key and per account. |

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
| **Gemini native GenAI dialect** | The `gemini` driver ships and serves Google's OpenAI-compatibility surface, so Gemini accounts route, fail over, and are accounted for like any other. The *native* GenAI protocol is what is deferred: it is a fourth dialect in the translation matrix, and the existing matrix earns that first. |
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

## Decided

Questions that were open here and are not any more. Kept so the answer is findable next to the
question it settles, and so nobody re-opens one by reading the old wording.

### Cost attribution for subscription accounts — **notional, and per Account**

A Claude Max or ChatGPT/Codex request has no per-request price. The three candidates were: report a
notional cost from the API price table, report tokens only, or model an amortized cost per token.

**Decision: notional.** A subscription account's tokens are valued at that vendor's public API rate
and reported as `costBasis: "notional"` — an attribution ("what these tokens would have cost on the
API"), shown as a separate total and never summed with metered spend. Amortization was rejected
because it needs a plan price, a period and a usage forecast the router does not have, and it turns
one operator's guess into a number that reads like a bill. Tokens-only was rejected because "which
subscription is carrying the load" and "what would this have cost us on the API" are both questions
an operator asks, and the second is unanswerable without a figure.

**The larger half of the decision: subscription-ness is a property of the *Account*, not of the
Provider.** `accounts.billing` is `metered` or `subscription`
([02-domain-model.md](02-domain-model.md#account)), written by the operator. The hardcoded
two-element set of "subscription providers" that used to live inside the cost estimator was right
about the two providers sold *only* that way and wrong about every other one: z.ai, Kimi and MiniMax
each sell a flat-fee coding plan behind the same endpoint and the same key shape as their metered
API, nothing on the wire distinguishes them, and a provider-derived answer priced a coding-plan
account and a pay-per-token one identically. That set answered two different questions with one
lookup.

- Providers sold **only** as a subscription (`anthropic-oauth`, `openai-oauth`) declare
  `billing: "subscription"` on their driver, and their Accounts are fixed there — there is no
  per-token price to meter, so the API refuses a `metered` write with `billing_fixed`. Declared on
  the driver rather than in a list, because "how is this one sold" is a fact about the provider and
  adding a provider is one file ([non-negotiable 12](../../CLAUDE.md)).
- Every other provider defaults to `metered`, and the operator may mark an Account as a plan.
- Migration `0014_account_billing` sets those two providers' rows to `subscription` and leaves every
  other row `metered` — exactly the set the estimator hardcoded, so no account's basis moves at the
  migration. A flat-fee coding plan bought behind a metered provider's endpoint therefore prices as
  ordinary `metered` spend until the operator marks the account, because the router cannot see the
  difference and a guessed subscription would restate a bill nobody sent.

Coverage of the answer is itself exported: `router_cost_basis_total{provider,model,basis}` counts
every attempt by how it was priced, so `basis="unknown"` over the total is the fraction of spend the
deployment cannot see ([08-observability.md](08-observability.md#cost-estimation)).

## Open questions

Genuinely unsettled. Listed so they are not mistaken for decided.

- **The Agent-SDK path's concurrency ceiling — measured for fixed cost, open for the ceiling
  itself.** Method: spawned the real `claude` CLI binary (the same one the SDK execs — see
  [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)) locally, single-process and in
  concurrent batches of 30 and 60, and polled `/proc/<pid>/status` for `VmRSS` at ~5 ms
  resolution until exit. A single uncontended process peaks at **~245 MB resident** (three runs:
  244.8 / 245.7 / 244.3 MB) — startup and runtime init, no live query. Under 30- and 60-way
  concurrent fan-out the same box averaged 170–195 MB sampled mid-run, consistent with the same
  fixed cost under scheduling contention. On the test host (12 cores, 45 GB RAM), `ulimit -n` is
  1,048,576 and `ulimit -u` is 65,535, and `/proc/sys/fs/file-max` / `kernel.pid_max` are 2,097,152
  / 4,194,304 — orders of magnitude above what memory allows at ~245 MB/process. **Conclusion: it
  breaks on memory first, not the process table or file descriptors**, on any host with normal
  Linux defaults, confirming the assumption `CLAUDE_SDK_MAX_CONCURRENCY`'s doc comment already made.
  What remains genuinely unmeasured is the ceiling **number** itself — "tens or low hundreds" was
  never a real constraint independent of available RAM. It doesn't need to be: capacity planning is
  `(available_RAM_MB − 512_MB_baseline) / ~245_MB`, a formula, not a constant — see
  [09-deployment.md](09-deployment.md#sizing). The measurement above did not exercise a live,
  authenticated `query()` session (this environment has no subscription credential to spend, and
  policy — see `CLAUDE.md` non-negotiable 1 and the testing rules — forbids hitting a real
  provider from CI or a shared test run); a manual, human-run session against a real account is the
  remaining method to confirm the ceiling holds under actual generation load, not just process
  startup.
- **Per-request memory cost of an SDK subprocess — fixed-startup portion measured, growth-with-
  conversation portion still open.** Same method as above: **~245 MB resident per process is the
  measured figure**, and it is fixed startup/runtime cost, not context size — a bare `--version`
  invocation reaches it before doing any conversational work. That retires half the question and
  confirms the "~200 MB" figure quoted elsewhere in the spec
  ([09-deployment.md](09-deployment.md), [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md),
  `apps/api/src/config/env.ts`) as measured rather than guessed. Still open, and honestly
  measured-unknown rather than answered: **whether resident memory grows with a long-running
  conversation's context.** Measuring that needs a live authenticated `query()` session carried
  across many turns while sampling `VmRSS` over time — this environment has no subscription
  credential to spend on it, and project policy keeps real providers out of CI. Until someone runs
  that session manually, size for the fixed ~245 MB per concurrent request and treat any additional
  growth as unbudgeted headroom, not zero.
- **Is advisory-lock leader election enough at multi-replica scale?** Each periodic task takes a
  Postgres advisory lock, so exactly one replica runs a given sweep and the rest skip. That is
  correct and nearly free at two or three replicas. Unsettled at more: a session-scoped lock is
  released on disconnect, so a replica that hangs without dropping its connection blocks the task
  until it dies, and a replica killed mid-sweep leaves a `ScheduledTaskRun` row open with no
  liveness signal behind it. Does that need a lock timeout, a heartbeat on the run row, or does the
  jittered next tick simply pick it up? Also unknown: whether the skipping replicas' lock attempts
  stay negligible as the task list grows. See
  [01-architecture.md](01-architecture.md#background-work-and-scheduling).
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
