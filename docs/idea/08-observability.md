# Observability

Status: design only. Nothing here is implemented. Retention knobs live in
[09-deployment.md](09-deployment.md).

## UsageRecord

**One row per upstream attempt — including failed attempts and every failed-over attempt.** A single
client request that hits a rate-limited account, fails over, and succeeds on the second produces
**two** rows. This is deliberate: the failure is the data you need. The two rows are joined by
`requestId`, the correlation id assigned at ingress and propagated end to end
([01-architecture.md](01-architecture.md)).

| Field | Type | Meaning |
|---|---|---|
| `id` | id | Row identity |
| `requestId` | string | Correlation id of the client-facing request. Shared by every attempt |
| `attempt` | int | 1-based attempt number within that request |
| `keyId` / `accountId` / `poolId` / `sessionId` | refs | Attribution: which router key presented, which Account served or failed, which Pool it was selected from, which Session it belongs to |
| `requestedModel` | string | Exactly what the client sent |
| `upstreamModel` | string | After the Account's alias map; equal to `requestedModel` when there is no alias |
| `ingressDialect` / `egressDialect` | enum | `anthropic` \| `openai-chat` \| `openai-responses` \| `agent-sdk` (egress only). Equal means passthrough |
| `streamed` | bool | Whether bytes reached the client (a streamed attempt is never retried) |
| `inputTokens` / `outputTokens` | int? | Upstream's own numbers, never the translated ones. Null when the upstream reported none |
| `cacheReadTokens` / `cacheCreationTokens` | int? | Where the provider reports them. Anthropic always does |
| `costEstimate` | decimal? | See below. Null when no price is known |
| `costBasis` | enum | `metered` \| `notional` \| `unknown` |
| `latencyMs` / `ttfbMs` | int / int? | Router-observed wall time for this attempt; time to first byte for streamed attempts |
| `routerOverheadMs` | int | Time in the router, excluding upstream — the per-record twin of `router_overhead_seconds` |
| `outcome` | enum | `success` \| `upstream_error` \| `rate_limited` \| `exhausted` \| `timeout` \| `client_error` \| `router_error`. `rate_limited` and `exhausted` are distinct outcomes, never folded together |
| `httpStatus` / `errorClass` | int? / string? | Upstream status when there was one; `RouterError` subclass name — never a message, never a body |
| `startedAt` / `finishedAt` | timestamp | |

**Written off the request path, always.** Records are handed to an in-memory queue and flushed to
Postgres in batches by a background writer. A request never waits on an insert, never opens a
transaction, and never fails because the database is slow. **A slow or unavailable database degrades
reporting, never traffic** — the queue is bounded, and on overflow it drops the oldest records and
increments a counter rather than applying backpressure to live requests. No prompt content, no
completion content, and no credential material is ever stored on a record.

> **Total prompt size is `inputTokens` + `cacheCreationTokens` + `cacheReadTokens`.** Every total,
> chart, and cost line here uses the sum. Reporting `inputTokens` alone counts only the uncached
> remainder and under-reports cached traffic badly — the better the caching, the worse the error,
> which is backwards from what an operator expects ([06-protocol-translation.md](06-protocol-translation.md)).

## Cost estimation

| | |
|---|---|
| Source | A static price table shipped with the image, keyed by `provider + model`, with input/output/cache rates |
| Override | The operator can edit or extend it in `/settings`. Overrides win; the shipped table is the fallback |
| Unknown model | `costEstimate` is null and `costBasis` is `unknown` — never silently zero, never guessed |

**Subscription accounts have no per-token price.** A Claude Max or ChatGPT/Codex account is a flat
monthly fee, so any per-request "cost" is an attribution, not a charge. Those rows are marked
`costBasis: "notional"` and valued at the equivalent public API price ("what this would have cost on
the API"). Metered and notional spend are shown as **separate totals**, never summed; notional figures
are marked with a one-line explanation, and "most expensive key" rankings default to metered.

## Usage reporting

**Usage is a headline feature, not a footnote.** The operator's recurring question is *"who burned
what"*, and the UI must answer it without anyone writing a query.

### Dimensions and windows

Every dimension supports the same windows, and every window supports the same measures.

| Slice by | Typical question |
|---|---|
| **Key** | Which agent is spending the most? Which key is erroring? |
| **Account** | Which subscription is carrying the load? Which one is rate-limited? |
| **Pool** | Is the policy spreading traffic the way I configured it? |
| **Model** | What are we actually calling? |
| Session | What did one conversation cost end to end? |

Windows: **lifetime** (never rolls off, because it comes from the daily rollup), **today** (current
UTC day, live), **7d** and **30d** trailing, and a **custom** `from`/`to` range.

Measures, identical in every dimension × window cell:

| Measure | Note |
|---|---|
| Requests | Client-facing requests, and upstream attempts as a separate number — never one figure |
| Input / output tokens | Input is the **three-field sum** above |
| Cache read / cache creation tokens | Broken out, because they are what explains a small `inputTokens` |
| Estimated cost | Metered and notional as **separate** totals (below) |
| Error rate | Share of client requests that ended in a non-success outcome |
| p50 / p95 latency | Router-observed, and `router_overhead_seconds` beside it so a slow upstream is not read as a slow router |

### Where the numbers appear

| Surface | What it shows |
|---|---|
| `/keys` table | A live total per row — requests and spend for the selected window, plus an inline sparkline. The operator sees the busy key without opening anything |
| Key detail | Full measure set, all windows, broken down by account and by model |
| `/accounts` table | Same live per-row totals, plus current quota utilization and reset ([below](#quota-resets-and-manual-re-check)) |
| Account detail | Full measure set, plus per-window quota history |
| `/pools` | Per-pool totals and the observed split across members — the answer to "is my policy doing what I set it to" |
| `/usage` | The dedicated screen: any dimension, any window, charts and leaderboards |

### Charts — data shapes, not a renderer

The renderer is **DEFERRED**. What is *not* deferred is the shape each chart consumes, because that
is the API contract.

| Chart | Data shape |
|---|---|
| Time series | Bucketed series (`bucket`, `value`) at an interval chosen from the range — hour for ≤ 2 days, day beyond — **stacked by key or by account**, one series per member, with an "other" series capping the series count |
| Quota-utilization gauge | Per Account per window: `{ window, utilization 0..1, resetsAt, resetSource }` |
| Top-N leaderboard | Ranked `{ dimension, label, measure }` rows — keys by spend, models by volume, accounts by errors. N is a parameter, ties broken by label |
| Inline sparkline | A bare `number[]` for the row's window, no axes, no labels — enough to see a shape in a table cell |

### Why it stays fast

Aggregates are read from **rolled-up daily rows**, never by scanning raw `UsageRecord`s: an hourly
task rolls raw records into per-day, per-(key, account, pool, model) aggregates. Raw rows expire on
the retention window while the rollup does not, so a lifetime total survives retention and a 30-day
chart never touches raw data. Today's partial day is the only slice computed from raw rows, bounded
by a single day's volume. Postgres aggregates; the request path is not involved.

## Quota, resets, and manual re-check

A degraded pool raises exactly two operator questions — *"when does it come back?"* and *"is it back
yet?"* — and both must be answerable without reading logs.

**Where the signal comes from.** For Claude subscription accounts, quota state arrives on the Agent
SDK's own `rate_limit_event` stream events: `status`, `resetsAt`, `rateLimitType` (`five_hour`,
`seven_day`, `seven_day_opus`, `seven_day_sonnet`), `utilization`, and overage fields. That is the
**primary** source — we do not poll an HTTP usage endpoint to learn what the stream already told us.
Other providers report through response headers, `Retry-After`, or a provider-specific balance field.

**Freshness is bounded by traffic, not by a poll interval.** The signal rides on responses the router
is already making, so an active Account's reading is as fresh as its last request; an idle Account
gets only a slow background floor and its reading can be old. That is precisely why **`lastCheckedAt`
is rendered next to every utilization figure** rather than hidden — a gauge without it is unreadable.

**Per window, not one number.** A Claude subscription runs several concurrent windows that reset
independently, so each Account exposes a row per window — utilization, reset timestamp, and which
window is currently the blocking one.

**Every reset timestamp carries its source, labeled.** A guessed reset shown as fact is worse than no
reset at all.

| `resetSource` | Meaning | UI treatment |
|---|---|---|
| `provider` | The provider told us (`resetsAt`, `Retry-After`) | Absolute local time + live countdown |
| `estimate` | Computed from the window type because the provider reported none | Same, visibly marked as an estimate |
| `unknown` | No signal; the breaker is on exponential backoff | No countdown. "Unknown — will retry with backoff" |

**`exhausted` has no reset, and that is the whole point.** An out-of-credits Account shows "needs
top-up" and never a countdown ([05-routing-and-failover.md](05-routing-and-failover.md)). Inventing an
ETA for a condition only a human can fix is a bug.

**Re-check now.** Per account and for all accounts at once. Providers reset early, lift limits, and
restore balances out of band, so the router must not sit on a timestamp it computed itself. The button
re-queries the live signal, updates utilization and resets, and returns the Account to `active`
immediately if it is healthy.

| Rule | |
|---|---|
| Cooldown | Server-side, per account, short. The button cannot be used to hammer a provider; a call inside the cooldown returns `429` with the remaining seconds |
| Same code path | It triggers the identical probe the circuit breaker runs on its half-open transition — the manual trigger, not a second implementation |
| Inline outcome | "still limited, resets 14:32" / "back online" / "still out of credits", with `lastCheckedAt` updated |
| Audited | `account.rechecked`, with the outcome |

## Endpoints

| Endpoint | Auth | Meaning | Codes |
|---|---|---|---|
| `GET /healthz` | none | Liveness. The process is up and serving | `200` always while serving |
| `GET /readyz` | none | Readiness: DB reachable **and** at least one Account in a healthy state | `200` ready, `503` with a short reason otherwise |
| `GET /metrics` | **DEFERRED** (bind-scoped or token) | Prometheus text exposition | `200` |
| `GET /v1/usage/quota` | router key or admin session | Per-Account, per-window utilization, `resetsAt`, `resetSource`, `status`, `lastCheckedAt` — the same shape the UI renders, so an operator can alert on it externally | `200` |
| `POST /admin/accounts/:id/recheck` | admin session | Manual re-check; `all` re-checks every account | `200`, `429` in cooldown |

`/healthz` never touches the database. `/readyz` is what an orchestrator gates traffic on — a router
with zero healthy accounts can serve nothing useful, so it reports not-ready rather than failing
every request at the last moment. `GET /v1/usage/quota` is scoped to the presenting key's reachable
accounts and returns labels and utilization only — never a credential, never an account's provider
identity beyond its label.

## Metrics

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `router_requests_total` | counter | `ingress_dialect`, `model`, `key_id`, `outcome` | Client-facing requests |
| `router_request_duration_seconds` | histogram | `ingress_dialect`, `model`, `streamed` | End-to-end client request latency, upstream time included |
| **`router_overhead_seconds`** | histogram | `ingress_dialect`, `path` (`passthrough`\|`translate`\|`agent_sdk`) | **Time spent in the router, excluding upstream.** First-class: shown on the dashboard next to upstream latency, because "the router is slow" and "the provider is slow" are different problems. A regression here is a bug, not a tuning opportunity ([06-protocol-translation.md](06-protocol-translation.md)) |
| `router_upstream_duration_seconds` | histogram | `provider`, `account_id`, `streamed` | Upstream time alone. Together with the above, the two halves always add up |
| `router_upstream_attempts_total` | counter | `provider`, `account_id`, `outcome` | Upstream attempts — one per `UsageRecord` row |
| `router_tokens_total` | counter | `provider`, `account_id`, `model`, `direction` (`input`\|`output`\|`cache_read`\|`cache_creation`) | Tokens consumed. `input` is the uncached remainder — sum all three input directions for prompt size |
| `router_upstream_errors_total` | counter | `provider`, `account_id`, `status`, `error_class` | Upstream failures by kind |
| `router_failovers_total` | counter | `pool_id`, `from_provider`, `reason` (`rate_limited`\|`exhausted`\|`upstream_error`\|`timeout`) | Times a request moved to the next candidate |
| `router_accounts` | gauge | `provider`, `status` (`active`\|`disabled`\|**`cooling_down`**\|**`exhausted`**\|`needs_reauth`) | Accounts by status. `cooling_down` and `exhausted` are **separate label values and never summed** — one comes back on a clock, the other needs a human. Alert on them differently |
| `router_quota_utilization` | gauge | `account_id`, `window` (`five_hour`\|`seven_day`\|`seven_day_opus`\|`seven_day_sonnet`\|`provider_specific`) | Fraction of a quota window consumed |
| `router_quota_reset_seconds` | gauge | `account_id`, `window`, `source` (`provider`\|`estimate`\|`unknown`) | Seconds until reset. Absent for `exhausted` accounts — there is no reset to report |
| `router_quota_last_checked_timestamp_seconds` | gauge | `account_id` | When the utilization above was last refreshed. Read the two together or you are alerting on a stale number |
| `router_usage_queue_depth` | gauge | — | Pending `UsageRecord`s awaiting batch write. Rising depth means reporting lag, not request lag |
| `router_usage_records_dropped_total` | counter | — | Records shed on queue overflow. Non-zero means the reporting path is behind; traffic is unaffected |
| `router_task_*` | — | `task` | Background task health — see [Scheduled task visibility](#scheduled-task-visibility) |

Label discipline: no unbounded label values. `key_id` and `account_id` are bounded by the
deployment's own inventory; `session_id`, `request_id`, and user-supplied strings are **never**
metric labels — they live on the `UsageRecord` and in logs.

## Structured logging

JSON lines to stdout, one object per event. The container logs; shipping them is the operator's job.

| Field | Always present |
|---|---|
| `ts`, `level`, `msg` | yes |
| `requestId` | yes on any request-scoped log — the same id joins client request, every upstream attempt, and every `UsageRecord` row |
| `component` | yes (`transport`, `routing`, `provider`, `translate`, `scheduler`, `admin`) |
| `accountId`, `keyId`, `model`, `attempt`, `durationMs`, `status` | when in scope |

| Level | Used for |
|---|---|
| `error` | A request the router could not serve; a failed OAuth refresh; a decrypt failure; a scheduled task that threw |
| `warn` | A failover, a circuit breaker opening, an account entering `needs_reauth` or `exhausted`, a rejected translation, a shed usage record |
| `info` | One line per completed client request; one per scheduled task run; startup and config summary |
| `debug` | Selection decisions, candidate sets, translation event counts |
| `trace` | **DEFERRED** |

**Never logged, at any level:** prompts, completions, request or response bodies, router key values,
upstream credentials or tokens, OAuth `code` / `state` / `code_verifier`, cookies, `Authorization`
and `x-api-key` headers. Redaction is default-on and is a tested unit — see
[07-security.md](07-security.md).

## Audit events

Append-only. Admin-plane mutations only; the data plane produces usage records, not audit events.

| Event | Recorded |
|---|---|
| `account.added` / `.removed` / `.updated` / `.reauthorized` / `.rechecked` | account id, label, provider, actor, timestamp; reauth records the flow mode (redirect \| paste), recheck records the outcome |
| `key.created` / `.revoked` / `.updated` | key id, name, pool binding, actor |
| `key.viewed` | key id — retrievable keys mean retrieval is itself auditable |
| `pool.created` / `.updated` / `.deleted`, `policy.changed` | pool id, membership change, old policy → new policy |
| `settings.changed` | setting name, old → new (secret-valued settings record the name only) |
| `admin.login` / `.login_failed` / `.logout` | source IP, timestamp |

Rules: append-only — no update, no delete outside the janitor's retention sweep. **Never contains
credential material**: no key values, no tokens, no password hashes. Field-level diffs record names
and non-secret values only.

## Scheduled task visibility

Background work runs as **in-process jittered interval timers coordinated by Postgres advisory
locks** — no BullMQ, no Redis/Dragonfly, no worker container, no system cron. Every task is
idempotent, resumable, and works in bounded batches; the rationale is in
[09-deployment.md](09-deployment.md). What belongs here is that **a task which silently stops running
is the failure this surface exists to catch.** Each run appends to `scheduled_task_runs` — task name,
started/finished, outcome, items processed — and `/settings` renders the latest row per task in plain
language (*"janitor last ran 4 min ago, deleted 812 rows"*). A task with no recent successful run is
called out, not left to inference.

| Task | Cadence |
|---|---|
| Janitor / retention sweeps | jittered interval |
| Usage rollup (raw → daily aggregates) | hourly; idempotent per (day, key, account, model) |
| Circuit-breaker half-open probes | scheduled per account when its reset passes — not a fixed interval |
| Quota refresh for idle subscription accounts | slow floor only; active accounts refresh from `rate_limit_event` traffic |
| Expired OAuth `state` / PKCE verifier purge | every few minutes |

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `router_task_last_success_timestamp_seconds` | gauge | `task` | Unix time of the last successful run. **The alert that matters**: age beyond a task's expected cadence means wedged or not scheduled |
| `router_task_duration_seconds` | histogram | `task` | Run time. Replaces the janitor-specific histogram |
| `router_task_items_total` | counter | `task` | Items processed — rows deleted, records rolled up, accounts probed |
| `router_task_consecutive_failures` | gauge | `task` | Resets to zero on success. Non-zero and climbing is a task failing quietly |
| `router_task_runs_total` | counter | `task`, `outcome` (`success`\|`failure`\|`skipped_locked`) | `skipped_locked` is normal on a replica that lost the advisory lock, not an error |

## Retention

Usage records, audit events, sessions, and OAuth state all expire on operator-tunable windows swept
by the janitor; raw usage rows roll up to daily aggregates in Postgres before they expire, which is
what keeps lifetime totals correct after the raw rows are gone. Defaults, batching rules, and the env
knobs are in [09-deployment.md](09-deployment.md).

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Request id propagation and where usage is written |
| [04-api-keys-and-access.md](04-api-keys-and-access.md) | Per-key attribution and limits |
| [05-routing-and-failover.md](05-routing-and-failover.md) | `cooling_down` vs. `exhausted`, failover, circuit-breaker events |
| [06-protocol-translation.md](06-protocol-translation.md) | The passthrough performance rules `router_overhead_seconds` measures |
| [07-security.md](07-security.md) | Redaction rules and what never reaches a log |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | The `rate_limit_event` stream that feeds every quota figure here |
