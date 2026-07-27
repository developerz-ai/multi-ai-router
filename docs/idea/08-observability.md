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
| `costBasis` | enum | `metered` \| `notional` \| `unknown`. Which of the first two a priced attempt takes comes from the **Account's** `billing`, not from its provider — see below |
| `latencyMs` / `ttfbMs` | int / int? | Router-observed wall time for the attempt; time to the first relayed byte. **TTFB is what makes "zero added time-to-first-token" a measurement** — `latencyMs` is dominated by generation time and hides a buffering regression completely |
| `routerOverheadMs` | int | Time in the router, excluding upstream — the per-record twin of `router_overhead_seconds` |
| `outcome` | enum | `success` \| `client_error` \| `translation_failed` \| `request_too_large` \| `key_revoked` \| `scope_violation` \| `key_rate_limited` \| `no_healthy_account` \| `quota_exhausted` \| `credits_exhausted` \| `upstream_error` \| `upstream_timeout` \| `upstream_auth_failed` \| `credential_decrypt_failed` \| `router_error`. Grouped by *whose problem it is* (`packages/core/src/domain/usage.ts`). Three that share a status but never fold together: `quota_exhausted` (a window a clock refills), `credits_exhausted` (a balance a human refills), and `key_rate_limited` (one key spent its own ceiling — not the operator's capacity) |
| `httpStatus` / `errorClass` | int? / string? | Upstream status when it answered; the thrown class's **name** — never a message, never a body |
| `createdAt` | timestamp | |

**Written off the request path, always.** Records are handed to an in-memory queue and flushed to
Postgres in batches by a background writer. A request never waits on an insert, never opens a
transaction, and never fails because the database is slow. **A slow or unavailable database degrades
reporting, never traffic** — the queue is bounded, and on overflow it drops the oldest records and
increments a counter rather than applying backpressure to live requests (`router_usage_queue_depth`
and `router_usage_records_dropped_total`, plus a throttled log line — a drop is never silent).
Shedding is also *cheap*: an enqueue costs the same whether the queue is empty or full and shedding,
because the queue advances a head rather than moving its contents. A queue that copied itself to
make room would charge every request during an outage for the whole ceiling — backpressure by
another name. No prompt content, no completion content, and no credential material is ever stored on
a record.

**A refused batch gets one more try, and both fates are exported.** Postgres is unavailable for a
second — a failover, a restart, a saturated connection pool — far more often than it is unavailable
at all, so a rejected batch is held and retried on the next flush rather than deleted on the spot.
It is held *beside* the queue, not pushed back into it: overflow sheds the oldest, and the batch
waiting for its retry is precisely the oldest. One retry is the whole ladder — a batch the writer
can never accept (a row it rejects, a statement past the bind ceiling) would otherwise come back
forever and starve every record behind it — after which it is discarded. Both steps land on
`router_usage_write_failures_total`, under `disposition="retried"` and `disposition="discarded"`,
because "the database blinked" and "rows no longer exist" are different incidents and alert
differently. The retry is logged at `warn` and the discard at `error`, throttled. The pass stops at
the first refusal rather than burning the rest of the queue against the same database, and a retried
batch is **not** re-counted into the attempt series: a blip must not show up on a dashboard as
upstream calls the router never made.

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
| Source | A static price table shipped with the image: one file per vendor under `services/cost/tables/`, assembled by `services/cost/prices.ts` and keyed by `provider + model`. Four numbers per model, per million tokens — input, output, cache read, cache write. Every file records where its numbers came from and what a stale row costs |
| Dated | `PRICE_TABLE_AS_OF` is the day every row was last checked against its vendor's published price, and it travels with the numbers: `prices.shippedAsOf` on `GET /api/admin/settings`, `router_price_table_asof_timestamp_seconds` on `/metrics`. **Update it in the same commit as any edit under `tables/`, and never without one** — a table nobody can date is a table nobody can judge, and its age is the only staleness signal an operator has |
| Coverage | Twelve vendor tables answer for fourteen providers. `anthropic-api` and `anthropic-oauth` share the Anthropic table; `openai-api` and `openai-oauth` share the OpenAI one; `gemini`, `zai`, `kimi`, `minimax`, `groq`, `deepseek`, `xai`, `mistral`, `together` and `cerebras` each have their own. **Four providers ship no price on purpose** — [below](#the-four-providers-that-ship-no-price) |
| Override | The operator edits or extends it in `/settings`, stored in `price_overrides` and held in a warm book beside the routing catalog. An override wins for the provider + model it names; the shipped table stays the fallback for everything else, so correcting one stale rate never costs the rest of the table. Same staleness bound as the catalog, because a price edited on another replica reaches this one the same way |
| Which model | The **upstream** model, after the Account's alias map — that is the name the upstream billed. A dated snapshot (`…-20251001`, `…-2025-04-14`) prices as its family, which is how the provider prices the pin. A snapshot the vendor prices apart from its family is named in full in its table, and the exact name is tried first |
| Long-context tiers | A model whose vendor publishes a long-context rate carries a second card that **replaces** the standard one once the prompt reaches its threshold — OpenAI above 272k, Google and xAI above 200k. Replaces, not tops up: those vendors bill the *entire* request at the higher rate once the prompt crosses the line, and charging only the excess would understate a long-context request by roughly half. The prompt measured is `tokensIn + cacheReadTokens + cacheWriteTokens` — how much context the request carried, not how much of it missed the cache. An **override is deliberately flat**: one written for a tiered model replaces both tiers, which is the operator saying "this is the rate, whatever the prompt" |
| Unknown model | `costEstimate` is null and `costBasis` is `unknown` — never silently zero, never guessed. A family released after the image was built, or an older snapshot the vendor no longer lists, prices as unknown rather than as the nearest thing to it |
| Priced, no tokens | `0` with a real basis. Zero tokens against a known rate is a measurement, not an admission |
| Cache rates | A model whose vendor publishes no cached-input price bills cached tokens at the **full input rate** — a discount nobody published is not assumed. A missing cache-*write* price is zero, because every vendor here except Anthropic bills the write as ordinary input on the call that created it, and charging again would double-count it. Anthropic's two are derived from its published multiples of input (0.1× read, 1.25× write) rather than restated per row; a response never says which cache TTL was written, so the 5-minute default is assumed and writes read low, never high |
| Estimated where computed | On the attempt, when the attempt ran. The price table and the alias map both change; a report needs what it cost then, not what the same tokens would cost today |

### The four providers that ship no price

Absent from the table and staying absent, because for each of them a shipped number would be a
fiction rather than a stale fact. Their attempts report `costBasis: "unknown"`, and the operator's
own override is the way to price them.

| Provider | Why no shipped rate |
|---|---|
| `openrouter` | The price is whichever upstream it routed to, decided per request. One table would price every route as one |
| `ollama` | The operator's own hardware. There is no per-token price to state, and `0` would claim electricity is free rather than that nobody billed for tokens |
| `openai-compatible` / `anthropic-compatible` | The operator's own contract with whatever sits behind the base URL they supplied. Only they know the rate — which is what overrides are for |

### Metered, notional, unknown

Three bases, and the third is a feature.

| Basis | When | Reported as |
|---|---|---|
| `metered` | A priced model on a pay-per-token account | Real spend |
| `notional` | A priced model on a **subscription** account. A flat fee has no per-request charge, so the figure is an attribution — "what these tokens would have cost on that vendor's API" | A separate total, **never summed with metered** |
| `unknown` | No rate for that provider + model, or no provider at all | NULL, never zero |

**The basis comes from the Account, not from the provider.** `accounts.billing` is either `metered`
or `subscription` ([02-domain-model.md](02-domain-model.md#account)), because the same provider sells
both: z.ai, Kimi and MiniMax each sell a flat-fee coding plan behind the same endpoint and the same
key shape as their metered API, and nothing on the wire tells them apart. Only the operator can say
which they bought. The two providers sold *only* as a subscription (`anthropic-oauth`,
`openai-oauth`) declare it on their driver and their accounts are fixed there — there is no
per-token price to meter, so the API refuses a `metered` write with `billing_fixed`. Everything else
defaults to `metered`.

A subscription account's tokens are valued against that vendor's public API table — the Anthropic
table for Claude subs, the OpenAI one for ChatGPT/Codex. Metered and notional spend are shown as
**separate totals**, never summed; notional figures are marked with a one-line explanation, and
"most expensive key" rankings default to metered.

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
| Error rate | Share of client requests that ended in a non-success outcome, **and the split behind it** ([below](#the-failure-split)) — one percentage is not an answer |
| p50 / p95 latency | Router-observed, and `router_overhead_seconds` beside it so a slow upstream is not read as a slow router |

### Where the numbers appear

| Surface | What it shows |
|---|---|
| `/keys` table | A live total per row — requests and spend for the selected window, plus an inline sparkline. The operator sees the busy key without opening anything |
| Key detail | Full measure set, all windows, broken down by account and by model |
| `/accounts` table | Same live per-row totals, plus current quota utilization and reset ([below](#quota-resets-and-manual-re-check)) |
| Account detail | Full measure set, plus per-window quota history |
| `/pools` | Per-pool totals and the observed split across members — the answer to "is my policy doing what I set it to" |
| `/usage` | The dedicated screen: any dimension, any window, charts and leaderboards, the [failure split](#the-failure-split) under the error-rate tile, and the live request feed below them |

### The failure split

**"3% of attempts failed" is not an answer.** The three failures this router produces have three
different remedies and three different statuses, and an operator reading one percentage cannot tell
which of them they are looking at: a spent window is `429` and comes back on a clock, a drained
balance is `402` and comes back when a human tops it up, and a key whose scope intersected the pool
to nothing is `403` and comes back when the operator widens it. Collapsing them is the mistake
[non-negotiable 7](../../CLAUDE.md) exists to prevent, and it is worth as much on the screen as it
is in the status codes.

So `GET /api/admin/usage` carries a `failures` object beside `totals`, and the console renders it
directly under the error-rate tile.

| Property | Rule |
|---|---|
| Source | Raw `usage_records`, grouped by `outcome` over the window. **Never `usage_daily`**: the rollup's grain is a key *and* an account, so every attempt that never reached one — nothing in scope, a revoked key, a body over the ceiling — is absent there by construction, and those are exactly the failures worth finding |
| Denominator | `failures.attempts` is that scan's own count, **not** `totals.attempts`. The totals are stitched from the rollup plus today's raw edges, and dividing a raw numerator by a stitched denominator is a share of nothing |
| `partial` | True when the window reaches past the raw rows the counts came from. The counts are then a **floor**, and the console says so before the numbers rather than under them |
| Grain | One entry per outcome that occurred, biggest first, ties broken by name so a page cannot reshuffle between refreshes. An outcome that did not occur is absent, not a zero |
| Grouping | The API reports **outcomes**; the console groups them into remedy classes. `quota_exhausted` and `credits_exhausted` are never merged at either layer |
| Zero state | The console shows rate limited / out of credits / out of scope **even at zero**. "Nothing was rate limited today" is an answer; an absent row is a question |

Each class on the screen prints its status and one line an operator can act on, so the panel reads
as *what to do next* rather than as a second table of counts. Colour is never the only carrier: a
row's dot takes the same `usageOutcomeFault` token the feed's dots take, and the class, the status
and the count are all spelt out beside it.

### The live request feed

The split says *which kind* of failure. It still does not say **which request** — and that is the
question an operator arrives with after a tool errored. Before the feed existed the answer was only
in the process logs, which an operator running a container cannot grep.

`GET /api/admin/usage/recent` returns individual `UsageRecord` rows, newest first, and the `/usage`
screen renders them as one row per **attempt**: a failover chain of three shows as three rows under
one request id, with the attempt number on each. Merging them would hide exactly the failover the
router exists to perform.

| Property | Rule |
|---|---|
| Filter | `failed=true` (every non-success outcome, derived from the `UsageOutcome` enum so a new outcome is never quietly excluded), or `outcome=<one outcome>`. Never both — that pairing is a `400`, not a silently-resolved preference. `quota_exhausted` and `credits_exhausted` stay separately selectable |
| Lookup | `requestId` matches the router's `correlation_id` **and** the caller's `x-request-id`. An operator holding an id off a failed run cannot know which of the two they have, so asking them to pick would be asking them to guess |
| `limit` | 1..200, default 50. Out of range is a `400`, never a silent clamp — a console that asked for 1000 and got 200 without being told would render a truncated page as a complete one |
| Columns | Named individually by the repository. `sessionKey` and the cost columns are deliberately absent, so a column added to the table never silently appears on an admin screen |
| Ordering | `created_at desc, id desc`. The tiebreaker is load-bearing: attempts of one chain are written from one batch and can share a millisecond, and a page that reshuffles between two refreshes reads as traffic that did not happen |
| Colour | The row's dot takes its token from `usageOutcomeFault` — whose problem the failure is. The outcome is always spelt out beside it, so colour is never the only carrier |

Nothing on the feed can carry credential material: `errorClass` is a class name rather than a
message, and no request or response body is stored anywhere to leak.

### Charts — data shapes and a renderer

| Chart | Data shape | Renderer |
|---|---|---|
| `/usage` time series | Bucketed series, one entry per axis point: `{ at, requests, attempts, errors }`, at an interval chosen from the range — hour for ≤ 2 days, day beyond | `UsageChart` — requests, attempts and errors on one shared y-scale (so a failover chain shows up as attempts drawing away from requests), with an axis labelled from the bucket's own `at`, not a synthetic index |
| Time series **stacked by key or by account** | One series per member, with an "other" series capping the series count | **DEFERRED** |
| Quota-utilization gauge | Per Account per window: `{ window, utilization 0..1, resetsAt, resetSource }` | Shipped — `QuotaWindowRow` |
| Top-N leaderboard | Ranked `{ dimension, label, measure }` rows — keys by spend, models by volume, accounts by errors. N is a parameter, ties broken by label | Shipped — `UsageTopN` |
| Inline sparkline | A bare `number[]` for the row's window, no axes, no labels — enough to see a shape in a table cell | Shipped — `Sparkline`, used in `UsageBreakdown` and the keys/accounts tables |

The window itself was reachable only as one of four named presets from the console until this was
closed: `GET /api/admin/usage` has taken a custom `from`/`to` since `services/usage-read/window.ts`
was written, and `/usage` now has the form that reaches it, alongside the four named buttons. A
custom range resolves to `window: "custom"` in the response, distinct from the four named labels.

`latency.ttfbP95Ms` — time to first byte — is part of the response and rendered as its own stat
tile (`Time to first byte p95`) beside router overhead. The two answer different questions: overhead
is the router's own added time, measured off the request's critical path; TTFT is measured on it, and
is the only one of the two that can catch a regression in the "never buffer a stream" rule
([non-negotiable 8](../../CLAUDE.md)).

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
| `GET /readyz` | none | Readiness: **database reachable, and no shutdown started**. Two dimensions are reported without gating the answer: the account pool (`ok` / `none` / `blocked`) and the `claude` CLI (the resolution rung that won, or `missing`) | `200` `ready`; `503` `not_ready` with a short reason when the database is unreachable; `503` `shutting_down` while draining |
| `GET /metrics` | `METRICS_TOKEN` when set, none when not | Prometheus text exposition | `200`, `401` when the token is set and not presented |
| `GET /v1/usage/quota` | router key or admin session | Per-Account, per-window utilization, `resetsAt`, `resetSource`, `status`, `lastCheckedAt` — the same shape the UI renders, so an operator can alert on it externally | `200` |
| `POST /api/admin/accounts/:id/recheck` | admin session | Manual re-check. `POST /api/admin/accounts/recheck` re-checks every account. For Claude subscriptions it also carries the credential probe, reported as `auth` | `200` always — a cooldown refusal is `rechecked: false`, not `429` |
| `GET /api/admin/usage` | admin session | Totals, series and breakdowns per key / account / pool / model over a window, plus the [failure split](#the-failure-split) behind the error rate | `200` |
| `GET /api/admin/usage/recent` | admin session | The [live request feed](#the-live-request-feed): individual attempts, newest first. `limit` (1..200), `failed` or `outcome` (never both), `requestId` (matches either id) | `200`, `400` on a limit out of range or both filters at once |

`/healthz` never touches the database.

**`/readyz` turns before the listener does.** On `SIGTERM` the shutdown latches first and the
endpoint answers `503 shutting_down` — with `checks: null`, because nothing was probed and a stale
`ok` would be a lie — *then* the drain begins
([09-deployment.md](09-deployment.md#shutdown--draining)). That ordering is the point: an
orchestrator polling readiness gets one honest refusal instead of learning about the shutdown from a
refused connection, which it would report as an error against whoever was mid-request. `/healthz`
stays `200` throughout — the process is up and finishing what it has, and restarting it now would
truncate exactly what the drain protects.

**The version is one string with five outlets** — `/healthz`, `router_build_info{version}`, the
`router listening` boot log line, `GET /api/admin/settings`, and the console footer. All five read
the `VERSION` constant in `packages/core`, which every workspace `package.json` restates and a unit
test holds them to. It is on `/healthz` because that is the one surface a deploy pipeline can reach
without a credential, so "did the new image actually roll out" has an answer that is not a log tail;
it is on the settings endpoint because the console footer must report *the server's* build, not the
one the loaded bundle was cut from.

**A tag cannot publish an image that disagrees with it.** `bin/verify-version` checks the tag
against that same `VERSION` constant and against every workspace manifest, and
[`release.yml`](../../.github/workflows/release.yml) runs it before it builds a single layer. It
reads the constant rather than the root `package.json` deliberately: the manifest is a copy, the
constant is what the five surfaces above report, and the release workflow never runs the test suite
— so the drift test that normally holds the two together does not gate a tag. Run it by hand before
cutting one ([RELEASING.md](../RELEASING.md)).

**The version says what the build calls itself; `ROUTER_REVISION` says which build it is.** Two
images can both be `1.0.0` — a rebuilt `latest`, an rc respin, an image built from a dirty tree.
The released image bakes the tagged commit's sha in as a build arg, and it reaches an operator
through `router_build_info{revision}` and the boot log. A build nobody stamped reports `unknown`.

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

Joining that path means joining its gate: exactly one request is admitted onto the account, and the
rest are told `429` until it reports
([05-routing-and-failover.md](05-routing-and-failover.md#exactly-one-half-open-probe)). Otherwise a
button that restores eligibility mid-outage is a button that throws the whole waiting backlog at the
account.

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
| `router_build_info` | gauge | `version`, `revision` | Always `1`; the labels are the payload. First in the exposition. Join on it — `router_build_info * on() group_left(version) …` — to annotate a graph with the build that produced it, instead of putting a `version` label on every other series and multiplying their cardinality to say the same thing once. `revision` is the commit sha the image was built from, because a version is not an identity: a rebuilt `latest`, an rc cut twice and a locally built image all report the same one. `unknown` when nothing stamped the build (`ROUTER_REVISION`) — never a fabricated sha |
| `router_requests_total` | counter | `ingress_dialect`, `model`, `key_id`, `outcome` | Client-facing requests |
| `router_request_duration_seconds` | histogram | `ingress_dialect`, `model`, `streamed` | End-to-end client request latency, upstream time included |
| **`router_overhead_seconds`** | histogram | `ingress_dialect`, `path` (`passthrough`\|`translate`\|`agent_sdk`) | **Time spent in the router, excluding upstream.** First-class: shown on the dashboard next to upstream latency, because "the router is slow" and "the provider is slow" are different problems. A regression here is a bug, not a tuning opportunity ([06-protocol-translation.md](06-protocol-translation.md)) |
| `router_upstream_duration_seconds` | histogram | `provider`, `account_id`, `streamed` | Upstream time alone. Together with the above, the two halves always add up |
| `router_upstream_attempts_total` | counter | `provider`, `account_id`, `outcome` | Upstream attempts — one per `UsageRecord` row |
| `router_tokens_total` | counter | `provider`, `account_id`, `model`, `direction` (`input`\|`output`\|`cache_read`\|`cache_creation`) | Tokens consumed. `input` is the uncached remainder — sum all three input directions for prompt size |
| `router_cost_basis_total` | counter | `provider`, `model`, `basis` (`metered`\|`notional`\|`unknown`) | **How much of this deployment's traffic the price table can see.** Every attempt that reached an account, priced or not — a counter that moved only for the priced ones would report 100% coverage of whatever it happened to cover. `basis="unknown"` over the total is the coverage ratio: the fraction of spend nobody here can report. Counted per attempt rather than in dollars, because a dollar sum would answer the question with the very number that is missing. Labelled by model (the name the client asked for, as on `router_tokens_total`) so a table gone stale against a renamed family shows up as one model going unknown rather than as a total quietly drifting |
| `router_price_table_asof_timestamp_seconds` | gauge | — | Unix time the shipped price table was last verified against its vendors (`PRICE_TABLE_AS_OF`). **Age is the signal** — `time() - router_price_table_asof_timestamp_seconds` past what the deployment tolerates is the alert. Fixed for the life of the process; absent rather than zero if the date fails to parse, because an epoch timestamp would claim the table was verified in 1970 |
| `router_price_overrides_loaded_timestamp_seconds` | gauge | — | Unix time the operator's price overrides were last loaded. **Absent until the first successful load.** Read it beside the gauge above: that one says how stale the shipped defaults are, this one says whether the corrections layered over them are arriving at all |
| `router_upstream_errors_total` | counter | `provider`, `account_id`, `status`, `error_class` | Upstream failures by kind |
| `router_failovers_total` | counter | `pool_id`, `from_provider`, `reason` (`rate_limited`\|`exhausted`\|`upstream_error`\|`timeout`) | Times a request moved to the next candidate |
| `router_accounts` | gauge | `provider`, `status` (`active`\|`disabled`\|**`cooling_down`**\|**`exhausted`**\|`needs_reauth`) | Accounts by status. `cooling_down` and `exhausted` are **separate label values and never summed** — one comes back on a clock, the other needs a human. Alert on them differently |
| `router_quota_utilization` | gauge | `account_id`, `window` (`five_hour`\|`seven_day`\|`seven_day_opus`\|`seven_day_sonnet`\|`provider_specific`) | Fraction of a quota window consumed |
| `router_quota_reset_seconds` | gauge | `account_id`, `window`, `source` (`provider-reported`\|`estimated`\|`unknown`) | Seconds until reset. Absent for `exhausted` accounts — there is no reset to report |
| `router_quota_last_checked_timestamp_seconds` | gauge | `account_id` | When the utilization above was last refreshed. Read the two together or you are alerting on a stale number |
| `router_usage_queue_depth` | gauge | — | Pending `UsageRecord`s awaiting batch write, the batch held for its retry included. Rising depth means reporting lag, not request lag |
| `router_usage_records_dropped_total` | counter | — | Records shed on queue overflow. Non-zero means the reporting path is behind; traffic is unaffected. A **different** failure from the one below, with a different fix: a bigger queue, versus a database that is up |
| `router_usage_write_failures_total` | counter | `disposition` (`retried`\|`discarded`) | Records in a batch the database refused. `retried` went back for one more try on the next flush — reporting is late, nothing is lost. `discarded` was refused twice and is **gone**. **Never summed**: a deployment where the first is occasionally noisy and the second is flat zero is working exactly as designed, and an alert on the sum pages for every blip. Alert on `discarded` |
| `router_sdk_subprocesses` | gauge | — | `claude` subprocesses running on this replica right now. Against `CLAUDE_SDK_MAX_CONCURRENCY` this is **memory in use**, not throughput — every one of them is a ~245 MB native binary ([09-deployment.md](09-deployment.md#sizing)). Per replica, like the gate itself. Counts the console's "Test now" probe too: it spawns the same process and takes the same slot |
| `router_sdk_subprocess_queue_depth` | gauge | — | Subscription requests **waiting** for a subprocess slot. Zero at any occupancy is a ceiling that fits; sustained depth is the signal to raise `CLAUDE_SDK_MAX_CONCURRENCY` (if RAM allows) or add a replica. Read it with the gauge above: full-and-empty is saturated-but-sufficient, full-and-queuing is not |
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
| Everything per **attempt** (`router_upstream_*`, `router_tokens_total`, `router_cost_basis_total`, `router_overhead_seconds`, `router_failovers_total`) | The usage recorder's **batch drain** — the same background pass that writes the rows | Lags a scrape by at most one flush interval. Never costs a request anything |
| `router_requests_total`, `router_request_duration_seconds` | Once per client request, where the request ends | Duration is measured to the response being handed back. A **streamed** body drains after that, so a streamed sample is time-to-response, not time-to-last-token — never average the two `streamed` label values together |
| `router_accounts`, `router_quota_*`, `router_usage_queue_depth`, `router_sdk_subprocess*`, `router_price_overrides_loaded_timestamp_seconds` | Sampled **per scrape** from the same warm state the request path reads | Cannot disagree with the router about which accounts are cooling down, or about how many subprocesses it is holding. A gauge mirrored on every acquire would put bookkeeping on the path the gate exists to bound |
| `router_price_table_asof_timestamp_seconds` | Set once at construction | The date is compiled into the image; nothing at runtime can move it |
| `router_task_*` | Each settled scheduler tick | `skipped_locked` records a run that never happened: no duration, no items, and the failure streak is left alone |

Two deliberate absences. `router_overhead_seconds` has no sample for a request rejected before an
egress path was chosen — there is no `path` to report, and inventing a fourth label value to hold
"none" would put router-only failures in the same series operators use to compare passthrough with
translation. And `router_failovers_total` counts a hop only once a **later** attempt of the same
request proves the router moved on, so a chain that gave up leaves its final failure uncounted:
it moved nowhere. Requests that failed outright are counted by `router_requests_total{outcome}`.

### What "excluding upstream" excludes

`router_overhead_seconds` is `totalMs - upstreamMs` for the request so far, and on a streamed reply
**the drain counts as upstream time**. Relaying is waiting, not working: the router is a pipe from
the first byte to the last, and charging a two-minute completion's stream to the router would put
generation time in the one series that exists to keep generation time out. What is left is the work
either side of the wire — key verification, session resolution, the health snapshot, selection, the
egress plan, header swapping, relay set-up, and the usage enqueue.

`upstreamMs` is the sum of one **span per attempt**, and both of its ends are exact. It opens when
the transport is handed the request — *after* the body for that attempt exists — and closes on the
attempt's verdict, or, for the attempt that succeeded, on its last relayed byte. So the conversion a
`translate` candidate needs, the alias rewrite a renamed one needs, and a credential that spent time
failing to decrypt all stay on the router's side of the subtraction. That boundary is what makes the
`path` label mean anything: a span opened at the *attempt's* start would subtract the conversion from
the very number `path="translate"` exists to price, and report the router's most expensive path as
its cheapest. An attempt that never reached a transport at all — an unreadable credential, a body
with no faithful conversion — waited on nothing and charges nothing.

The invariant that follows is what the tests assert: a request whose upstream took 400 ms records a
`routerOverheadMs` in single digits, not 400-and-change, and one whose conversion took 30 ms records
those 30. `router_overhead_seconds` and `router_upstream_duration_seconds` are complements over one
wall clock, never two views of the same milliseconds — and if they ever start to double-count, the
overhead number is the one that has gone wrong, because upstream time is the number with an
independent witness.

### Verifying the budget

The budget in [01-architecture.md](01-architecture.md) is two claims, and they need two
measurements, so `bin/bench` reports them as two tables:

| Claim | Measured as |
|---|---|
| **< 5 ms added p99** | Read straight off `router_overhead_seconds` via `GET /metrics`, after driving concurrent requests through the real router against an in-process stub upstream. Nothing external is timed — the series that alerts is the series that is checked |
| **Zero added time-to-first-token** | The stub records when it released its first byte; the driver records when the client saw one. The difference is what the router added, and its **p95 is held to `--ttft-budget-ms` (default 2 ms)**. A first client byte arriving *after* the upstream's last is the extreme case — a relay that buffered — and fails by that name instead of as a slow percentile |

Both non-SDK egress paths are covered, streamed and not. The Agent-SDK path is excluded: it spawns a
subprocess per request and is the budget's labeled exception.

**Why the two claims are read at different quantiles.** `router_overhead_seconds` is a bucketed
histogram fed whole-millisecond samples, so its tail is bounded by the bucket edges and a p99 read
off it is stable run to run. Added TTFT is a raw sample series timed across an async relay on one
event loop: its p50 and p95 move under 15% between runs on an idle box, while its **p99 was measured
moving 0.56 → 4.03 ms across four consecutive runs of identical code**. That tail is the scheduler,
not the router, and gating it would fail runs for being unlucky. p95 gives up nothing, because every
way the router can actually add time to a first token — buffering the relay, awaiting Postgres or a
body parse before forwarding, a translation that accumulates before it emits — charges *every*
stream and moves p50 and p95 together.

One sensitivity worth knowing before reading a pass as proof: work the router does **before** the
upstream's first byte exists is absorbed, not measured, because the client was going to wait anyway.
The stub's `--first-byte-ms` (default 20) is therefore the floor on what a pre-relay delay has to
exceed to register. That matches what a client actually experiences — a real upstream's first token
is hundreds of milliseconds out, so the router has at least that much slack — but it means the
number answers "did the client wait longer", not "did the router do more work". The latter is what
`router_overhead_seconds` is for, which is why both are reported.

Two honesty notes the tool prints for itself. The series is fed whole-millisecond samples
(`routerOverheadMs` is an integer column), so every percentile below 1 ms is a bucket bound rather
than a measurement and the **mean** is the number with sub-millisecond resolution. And concurrency
against a fast stub is load-shaping, not realism: an upstream that answers instantly saturates the
event loop, and the queueing that follows is genuinely time in the router, so it lands in the
histogram. The defaults sit well under saturation; raising `--concurrency` or dropping
`--first-byte-ms` measures the saturation point instead, which is a fair thing to want and a
different thing to read.

`bin/bench` exits non-zero when either claim breaks, which makes it usable as a gate. It is
deliberately **not** part of `bin/check`: a timing measurement on a shared CI runner is a flaky
test, and a flaky gate is one people learn to skip.

### CI: a report, not a gate

`.github/workflows/ci.yml` runs a `bench` job after `test`, on the same shared `blacksmith-*`
runner as everything else. It never fails the build — the step is `continue-on-error: true` — for
the same reason `bin/bench` stays out of `bin/check`: a shared runner's jitter is not a signal
worth blocking a merge over, and a gate nobody trusts gets ignored.

What it produces instead:

- **`bin/bench --json --baseline bench/baseline.json`** — runs the harness and prints its normal
  verdict plus a `delta` block comparing every scenario's overhead mean and p99, and every streamed
  scenario's added-TTFT p95, against the numbers committed in `bench/baseline.json`. Both halves of
  the budget: a regression that stays under an absolute ceiling still deserves to be visible on the
  PR that introduced it.
- The JSON is written to the job's **summary** (visible on the PR, no log-diving) and uploaded as
  the `bench-report` **artifact** (30-day retention), so a trend across PRs is one download away.

`bench/baseline.json` is a committed, versioned file (`{"version": 2, "budgets", "rows": [...]}`)
— not derived at CI time — so the delta is against a number a human chose to keep, not against
whatever the previous run on a possibly-noisier runner happened to produce. A baseline written by an
older format is **refused**, not silently diffed: a version-1 file predates the added-TTFT ceiling
and carries no p95 to compare, so comparing against one would report "no drift" for precisely the
number that had until then gone unwatched.

**Re-baselining**, after an intentional performance change (or before cutting a release, alongside
a `bin/bench` smoke run):

```
bin/bench --write-baseline bench/baseline.json
git add bench/baseline.json
git commit -m "bench: re-baseline after <why>"
```

Run it locally, not in CI — the same "shared runner is noisy" reasoning that keeps the job
non-blocking means a runner-generated baseline would just be next week's false regression. State
*why* the numbers moved in the commit message; the diff itself only ever shows *that* they did.

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
upstream credentials or tokens, OAuth `code` / `state` / `code_verifier`, cookies, `Authorization`,
`x-api-key`, and `x-goog-api-key` headers. The redactor also catches a credential that arrives under
an honest-looking field name — JWTs, `postgres://user:pass@host` connection strings, a key in a
query string, `Bearer` and `Basic` header values, and the vendor key shapes (`sk-`, `AIza`, `ghp_`,
`xai-`, `gsk_`). Redaction is default-on and is a tested unit — see
[07-security.md](07-security.md).

Three properties of the redactor are load-bearing enough to state:

- **The whole line is covered, `msg` included.** Every call site passes a constant message today;
  the scrub is there so the day one interpolates an upstream's reply, the guarantee above still
  holds.
- **Field names match with `-` and `_` stripped.** `api-key`, `api_key`, and `apiKey` are one
  field, and so are `encryption_key` and `encryptionKey` — a call site cannot open a hole by
  picking the separator the list happens not to carry. There is deliberately no bare `key` marker:
  `keyId` and `keyName` are on every request-scoped line and are how an operator reads it.
- **It fails closed.** The walk stops at four levels of nesting and redacts whatever is below.
  `Error`, `Map`, and `Set` values keep their payload somewhere `Object.entries` cannot see, so
  each is unwrapped and scrubbed rather than serialized as an empty object.

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
| Orphaned `CLAUDE_CONFIG_DIR` reap | every few hours; removes only unclaimed directories past `RETENTION_ORPHAN_CONFIG_DIR_HOURS` |

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
| `router_task_items_total` | counter | `task` | Items processed — rows deleted, records rolled up, accounts probed, config directories reaped |
| `router_task_consecutive_failures` | gauge | `task` | Resets to zero on success. Non-zero and climbing is a task failing quietly |
| `router_task_runs_total` | counter | `task`, `outcome` (`success`\|`failure`\|`skipped_locked`) | `skipped_locked` is normal on a replica that lost the advisory lock, not an error |

## Retention

Usage records, daily aggregates, audit events, sessions, scheduled-task runs, and OAuth state all
expire on operator-tunable windows swept by the janitor; raw usage rows roll up to daily aggregates
in Postgres before they expire, which is what keeps lifetime totals correct after the raw rows are
gone. The aggregates outlive the raw rows by design and are swept on their own, much wider window —
never a shorter one, which boot refuses, because the janitor and the rollup would then delete and
re-insert the same days forever. The rollup itself writes **one statement per UTC day**, so a
first-boot catch-up across the retention floor is a bounded, resumable walk rather than one
transaction. Defaults, batching rules, and the env knobs are in
[09-deployment.md](09-deployment.md).

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Request id propagation and where usage is written |
| [04-api-keys-and-access.md](04-api-keys-and-access.md) | Per-key attribution and limits |
| [05-routing-and-failover.md](05-routing-and-failover.md) | `cooling_down` vs. `exhausted`, failover, circuit-breaker events |
| [06-protocol-translation.md](06-protocol-translation.md) | The passthrough performance rules `router_overhead_seconds` measures |
| [07-security.md](07-security.md) | Redaction rules and what never reaches a log |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | The `rate_limit_event` stream that feeds every quota figure here |
