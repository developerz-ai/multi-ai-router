# Observability

Status: **`UsageRecord` writing, structured logging, redaction, audit events, the usage API, cost
estimation with operator-editable price overrides, the scheduled tasks and their admin surface, the
quota surface (per-window gauges, reset countdowns, top-N, sparklines), and `/healthz` + `/readyz` +
`/metrics` are all implemented.** The field table below matches the shipped schema; the rest is the
contract those surfaces must meet. Retention knobs live in [09-deployment.md](09-deployment.md).

## UsageRecord

**One row per upstream attempt — including failed attempts and every failed-over attempt.** A single
client request that hits a rate-limited account, fails over, and succeeds on the second produces
**two** rows. This is deliberate: the failure is the data you need. The two rows are joined by
`correlationId`, assigned at ingress and propagated end to end
([01-architecture.md](01-architecture.md)).

| Field | Type | Meaning |
|---|---|---|
| `id` | id | Row identity |
| `correlationId` | uuid | Shared by every attempt of one client request. **Router-owned**, always a UUID |
| `clientRequestId` | string? | The caller's `x-request-id`, verbatim, when it sent one. A **trace** field, never a join key — it is caller-controlled, so two clients both sending `req-1` must not have their chains merged |
| `attempt` | int | 1-based position in the failover chain |
| `apiKeyId` / `accountId` / `poolId` / `sessionKey` | refs | Attribution: which key presented, which Account served or failed, which Pool it was selected from, which conversation it belonged to. `poolId` is null when the key's scope was `all` or an explicit account list — no pool was in play |
| `provider` | enum? | Denormalized so the row survives the Account it names |
| `model` | string | Exactly what the client sent. Never substituted |
| `upstreamModel` | string? | The name actually put on the wire, after the Account's alias map. A separate **fact**, not a derivation: the alias map is mutable, so re-deriving it later answers "what would we send now", never "what did we send then" |
| `ingressDialect` | enum? | The API surface the client called |
| `egressMode` | enum? | `passthrough` \| `translate` \| `agent-sdk` — the per-row twin of the `path` label on `router_overhead_seconds`. Carried instead of an egress *dialect*: the fact worth storing is the relationship between the two, and the SDK path has no egress dialect at all |
| `streamed` | bool | Whether bytes reached the client. A streamed attempt is never retried, so this column is the audit of that rule |
| `tokensIn` / `tokensOut` | int | Upstream's own numbers, never the translated ones |
| `cacheReadTokens` / `cacheWriteTokens` | int | Where the provider reports them. Anthropic always does |
| `costEstimate` | decimal? | See below. Null for an unknown model — never silently zero |
| `costBasis` | enum | `metered` \| `notional` \| `unknown` |
| `latencyMs` / `ttfbMs` | int / int? | Router-observed wall time for the attempt; time to the first relayed byte. **TTFB is what makes "zero added time-to-first-token" a measurement** — `latencyMs` is dominated by generation time and hides a buffering regression completely |
| `routerOverheadMs` | int | Time in the router, excluding upstream — the per-record twin of `router_overhead_seconds` |
| `outcome` | enum | `success` \| `client_error` \| `translation_failed` \| `key_revoked` \| `scope_violation` \| `key_rate_limited` \| `no_healthy_account` \| `quota_exhausted` \| `credits_exhausted` \| `upstream_error` \| `upstream_timeout` \| `upstream_auth_failed` \| `credential_decrypt_failed` \| `router_error`. Grouped by *whose problem it is* (`packages/core/src/domain/usage.ts`). Three that share a status but never fold together: `quota_exhausted` (a window a clock refills), `credits_exhausted` (a balance a human refills), and `key_rate_limited` (one key spent its own ceiling — not the operator's capacity) |
| `httpStatus` / `errorClass` | int? / string? | Upstream status when it answered; the thrown class's **name** — never a message, never a body |
| `createdAt` | timestamp | |

**Written off the request path, always.** Records are handed to an in-memory queue and flushed to
Postgres in batches by a background writer. A request never waits on an insert, never opens a
transaction, and never fails because the database is slow. **A slow or unavailable database degrades
reporting, never traffic** — the queue is bounded, and on overflow it drops the oldest records and
increments a counter rather than applying backpressure to live requests (`router_usage_queue_depth`
and `router_usage_records_dropped_total`, plus a throttled log line — a drop is never silent). No
prompt content, no completion content, and no credential material is ever stored on a record.

One request writes no record at all: a key refused for exceeding **its own** rate limit
([04-api-keys-and-access.md](04-api-keys-and-access.md#per-key-controls)). The check runs before the
body is read, so there is no model and no session to attribute a row to, and a refusal that
allocated a record per attempt would be an amplifier rather than a limit. It is counted on
`router_requests_total{key_id,outcome="key_rate_limited"}`, which is per key already.

> **Total prompt size is `tokensIn` + `cacheWriteTokens` + `cacheReadTokens`.** Every total,
> chart, and cost line here uses the sum. Reporting `tokensIn` alone counts only the uncached
> remainder and under-reports cached traffic badly — the better the caching, the worse the error,
> which is backwards from what an operator expects ([06-protocol-translation.md](06-protocol-translation.md)).

## Cost estimation

| | |
|---|---|
| Source | A static price table shipped with the image (`services/cost/prices.ts`), keyed by `provider + model`, with input/output/cache rates. Every entry carries its provenance |
| Override | The operator edits or extends it in `/settings`, stored in `price_overrides` and held in a warm book beside the routing catalog. An override wins for the provider + model it names; the shipped table stays the fallback for everything else, so correcting one stale rate never costs the rest of the table. Same staleness bound as the catalog, because a price edited on another replica reaches this one the same way |
| Which model | The **upstream** model, after the Account's alias map — that is the name the upstream billed. A dated snapshot (`…-20251001`) prices as its family, which is how the provider prices the pin |
| Unknown model | `costEstimate` is null and `costBasis` is `unknown` — never silently zero, never guessed. Same for a provider with no published per-model list: an aggregator's price depends on the route it chose, and a `*-compatible` endpoint is the operator's own contract |
| Priced, no tokens | `0` with a real basis. Zero tokens against a known rate is a measurement, not an admission |
| Cache rates | Where a provider states them as multiples of its input rate, they are derived, not restated. A response never says which cache TTL was written, so the cheaper default is assumed — cache writes read low, never high |
| Estimated where computed | On the attempt, when the attempt ran. The price table and the alias map both change; a report needs what it cost then, not what the same tokens would cost today |

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
| `provider-reported` | The provider told us (`resetsAt`, `Retry-After`) | Absolute local time + live countdown |
| `estimated` | Computed from the window type because the provider reported none | Same, visibly marked as an estimate |
| `unknown` | No signal; the breaker is on exponential backoff | No countdown. "Unknown — will retry with backoff" |

The three values are `ResetSource` in `packages/core` — the enum the API, the database, and the SPA
all derive from. Never restate them.

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
| `GET /healthz` | none | Liveness. The process is up and serving, and the build it is: `{"status":"ok","version":"1.0.0"}` | `200` always while serving |
| `GET /readyz` | none | Readiness: **database reachable**. Two dimensions are reported without gating the answer: the account pool (`ok` / `none` / `blocked`) and the `claude` CLI (the resolution rung that won, or `missing`) | `200` ready, `503` with a short reason when the database is unreachable |
| `GET /metrics` | `METRICS_TOKEN` when set, none when not | Prometheus text exposition | `200`, `401` when the token is set and not presented |
| `GET /v1/usage/quota` | router key or admin session | Per-Account, per-window utilization, `resetsAt`, `resetSource`, `status`, `lastCheckedAt` — the same shape the UI renders, so an operator can alert on it externally | `200` |
| `POST /api/admin/accounts/:id/recheck` | admin session | Manual re-check. `POST /api/admin/accounts/recheck` re-checks every account. For Claude subscriptions it also carries the credential probe, reported as `auth` | `200` always — a cooldown refusal is `rechecked: false`, not `429` |
| `GET /api/admin/usage` | admin session | Totals, series and breakdowns per key / account / pool / model over a window | `200` |

`/healthz` never touches the database.

**The version is one string with five outlets** — `/healthz`, `router_build_info{version}`, the
`router listening` boot log line, `GET /api/admin/settings`, and the console footer. All five read
the `VERSION` constant in `packages/core`, which every workspace `package.json` restates and a unit
test holds them to. It is on `/healthz` because that is the one surface a deploy pipeline can reach
without a credential, so "did the new image actually roll out" has an answer that is not a log tail;
it is on the settings endpoint because the console footer must report *the server's* build, not the
one the loaded bundle was cut from.

**`/readyz` deliberately does not gate on healthy accounts**, though the obvious design says it
should. A fresh install has zero accounts, so gating would mean it is never ready, so an
orchestrator never routes traffic to the admin console *served by this same process* — the only
way to add the first account. The router would be permanently not-ready with no way out. So the
account dimension is reported and not gated: `none` (nothing configured yet), `blocked` (accounts
exist and every one is unavailable) and `ok` are distinct, each carries a reason, and the probe
reads the same warm snapshot the request path reads so it cannot disagree with the router about
what is routable.

**The `claude` CLI dimension is reported for a second reason:** it matters only to Claude
subscription accounts, so a deployment with none — or with API-key accounts only — is fully
functional without it, and gating on it would withhold traffic from a router that has nothing wrong.
What it answers is *which rung of the resolution ladder won* (`env_override`, `bundled_binary`,
`platform_package`, `path_lookup`, `legacy_install`, or `missing`), because "the wrong `claude` got
picked" is otherwise indistinguishable from any other Agent SDK failure. The resolved **path** is in
the boot log, not the response: this endpoint is unauthenticated. It re-resolves per request, so an
operator who fixes a bad mount sees the answer change without a restart
([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md#9-operational-notes)).

A re-check is **not a synthetic probe**. It clears the account's breaker marks, which is the state
a cooldown expiring produces, so the account becomes eligible as a half-open probe and the next
real request tests it. One recovery path, not two that can disagree — and no unbilled request to a
provider on a button press. The consequence is that a re-check reports eligibility, never a verdict
on whether the account is back.

**Claude subscriptions get one extra answer, and it costs nothing.** For those accounts the re-check
also runs `claude auth status` against the account's own config directory — a local file read, no
provider contacted — and returns `auth: {loggedIn, email, subscriptionType}` beside the eligibility
result. That is a different fact from "is the window back", and it is what makes a silently revoked
login visible before every request to the account has already failed. Logged out moves an `active`
account to `needs_reauth`; logged in clears `needs_reauth`. A `disabled` account is never touched,
and a CLI that cannot answer reports *nothing* rather than a definite "logged out". Every effective
re-check writes an `account.rechecked` audit event; a cooldown refusal writes none, because nothing
happened. Rationale: [11-anthropic-agent-sdk.md §3.2](11-anthropic-agent-sdk.md).

`GET /v1/usage/quota` is scoped to the presenting key's reachable
accounts and returns labels and utilization only — never a credential, never an account's provider
identity beyond its label.

## Metrics

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `router_build_info` | gauge | `version` | Always `1`; the label is the payload. First in the exposition. Join on it — `router_build_info * on() group_left(version) …` — to annotate a graph with the build that produced it, instead of putting a `version` label on every other series and multiplying their cardinality to say the same thing once |
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
| `router_quota_reset_seconds` | gauge | `account_id`, `window`, `source` (`provider-reported`\|`estimated`\|`unknown`) | Seconds until reset. Absent for `exhausted` accounts — there is no reset to report |
| `router_quota_last_checked_timestamp_seconds` | gauge | `account_id` | When the utilization above was last refreshed. Read the two together or you are alerting on a stale number |
| `router_usage_queue_depth` | gauge | — | Pending `UsageRecord`s awaiting batch write. Rising depth means reporting lag, not request lag |
| `router_usage_records_dropped_total` | counter | — | Records shed on queue overflow. Non-zero means the reporting path is behind; traffic is unaffected |
| `router_task_*` | — | `task` | Background task health — see [Scheduled task visibility](#scheduled-task-visibility) |

Label discipline: no unbounded label values. `key_id` and `account_id` are bounded by the
deployment's own inventory; `session_id`, `request_id`, and user-supplied strings are **never**
metric labels — they live on the `UsageRecord` and in logs. `model` is the one label a client can
influence, so it is truncated and every metric stops adding series at a per-metric ceiling rather
than growing without bound; hitting the ceiling logs a `warn` naming the metric.

### Where the numbers come from

Recording is off the critical path by construction, and reading the series correctly depends on
knowing which clock each one is on:

| Series | Fed from | Reads as |
|---|---|---|
| Everything per **attempt** (`router_upstream_*`, `router_tokens_total`, `router_overhead_seconds`, `router_failovers_total`) | The usage recorder's **batch drain** — the same background pass that writes the rows | Lags a scrape by at most one flush interval. Never costs a request anything |
| `router_requests_total`, `router_request_duration_seconds` | Once per client request, where the request ends | Duration is measured to the response being handed back. A **streamed** body drains after that, so a streamed sample is time-to-response, not time-to-last-token — never average the two `streamed` label values together |
| `router_accounts`, `router_quota_*`, `router_usage_queue_depth` | Sampled **per scrape** from the same warm state the request path reads | Cannot disagree with the router about which accounts are cooling down |
| `router_task_*` | Each settled scheduler tick | `skipped_locked` records a run that never happened: no duration, no items, and the failure streak is left alone |

Two deliberate absences. `router_overhead_seconds` has no sample for a request rejected before an
egress path was chosen — there is no `path` to report, and inventing a fourth label value to hold
"none" would put router-only failures in the same series operators use to compare passthrough with
translation. And `router_failovers_total` counts a hop only once a **later** attempt of the same
request proves the router moved on, so a chain that gave up leaves its final failure uncounted:
it moved nowhere. Requests that failed outright are counted by `router_requests_total{outcome}`.

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

`subject_id` is text, not a uuid, for the same reason `kind` is text: not every audited subject is a
row. A settings change names the setting it changed (`price_overrides`), an admin login names the
configured operator. A failed login records the source address and whether the attempt named the
configured admin — never the string that was typed, because a password fat-fingered into the
username box, or a probe's guesses, would otherwise be written to an append-only table. Auditing a
login is reporting and never part of the decision: the append is fired, not awaited, so a rejected
write cannot turn a correct password into a `500`, and both branches make exactly one non-blocking
call so the log can never become an oracle for which half of the credential was wrong.

`GET /api/admin/audit` serves the console's feed, newest first, paged by `limit`.

## Scheduled task visibility

Background work runs as **in-process jittered interval timers coordinated by Postgres advisory
locks** — no BullMQ, no Redis/Dragonfly, no worker container, no system cron. Every task is
idempotent, resumable, and works in bounded batches; the rationale is in
[09-deployment.md](09-deployment.md). What belongs here is that **a task which silently stops running
is the failure this surface exists to catch.** Each run appends to `scheduled_task_runs` — task name,
started/finished, outcome, items processed — and `/settings` renders the latest row per task in plain
language (*"janitor last ran 4 min ago, deleted 812 rows"*), served by `GET /api/admin/tasks`. A task
with no recent successful run is called out, not left to inference: the health it reports is
`never_run`, `running`, `ok`, `stale` or `failing`, judged against the cadence *this process is
actually running* — the intervals come from the same registry the scheduler was built from, so the
screen cannot call a task healthy on a schedule nobody configured. A run left open past its own
interval reads `stale`, which is what a wedged task looks like from the outside.

| Task | Cadence |
|---|---|
| Janitor / retention sweeps | jittered interval |
| Usage rollup (raw → daily aggregates) | hourly; idempotent per (day, key, account, model) |
| Circuit-breaker half-open probes | scheduled per account when its reset passes — not a fixed interval |
| Quota refresh for idle subscription accounts | slow floor only; active accounts refresh from `rate_limit_event` traffic |
| Expired OAuth `state` / PKCE verifier purge | every few minutes |

### The catalog refresh is not a scheduled task

Two background timers run in this process and they are **deliberately different things**. Confusing
them is how someone "fixes" the catalog by putting an advisory lock on it and breaks every replica
but one.

| | Scheduled tasks (janitor, rollup, purge) | Catalog refresh |
|---|---|---|
| Coordination | One `pg_try_advisory_lock` per task — **exactly one replica** runs it | **None. Every replica runs its own** |
| Why | The work mutates shared state; running it twice is waste at best | The work populates *this process's* memory. A replica that skips it serves stale routing forever |
| Recorded | A `ScheduledTaskRun` row per run | No row. It is a cache load, not a unit of work |
| Failure | Recorded, surfaced, alertable | Swallowed; the previous snapshot stays in place and the next tick retries |
| Cadence | Task-specific, jittered | `CATALOG_REFRESH_SECONDS`, jittered ±20% so replicas that started together do not refresh in lockstep |

What the interval actually bounds: **how long this replica may lag a write made by another
replica.** A write by *this* replica refreshes it immediately and before the response is written, so
in a single-replica deployment the interval is nearly irrelevant. Detail:
[01-architecture.md](01-architecture.md#the-warm-routing-catalog).

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
