# Routing and Failover

Status: **implemented** in `apps/api/src/services/routing/` — scope intersection, the candidate
filter, all six policies, overflow, bounded failover, and the circuit breaker, all as pure functions
over an injected snapshot. Also built: persisted quota-window state (`packages/db/src/schema/quota-windows.ts`,
kept fresh by the `quota-floor` scheduled task), the half-open recovery probe (manual **Re-check now**,
`services/accounts/recheck.ts`, sharing its one code path with the automatic transition), and the
persisted Session→Account binding the Agent-SDK path needs (`providers/claude-sdk/session/store.ts`).

> **The client picks the model. The router picks the account.**

Everything below is the second half of that sentence. Selection never reads the prompt, never
re-ranks the model, and never substitutes a cheaper one.

## The normal shape of a pool

A pool is usually **many accounts of the same provider**, not one account per provider:
five Claude Max subscriptions, three z.ai keys, two ChatGPT subscriptions, one OpenRouter key —
side by side, distinguished by `label`. Every rule on this page operates over that shape. Five
Claude subs means five independent quota windows, and that is precisely what makes these
policies worth having. Nothing here assumes one account per provider.

## The selection chain

```
  request + router key
          │
          ▼
  1. RESOLVE SCOPE     key scope → all | pool(s) | explicit account list
          │
          ▼
  2. INTERSECT         key scope ∩ pool membership → candidate set
          │            (never a union, never widened)
          ▼
  3. FILTER            drop: disabled · cooling_down · exhausted · needs_reauth
          │                  no quota headroom · model unsupported
          ▼
     candidates == 0? ──yes──▶  specific error by cause:
          │no                    429 + Retry-After · 402 · 403
          ▼
  4. POLICY            sticky | round-robin | weighted
          │            least-used | priority-failover | quota-aware
          ▼
     ordered candidate list  ─────────────┐
          │                               │
          ▼                               │
  5. ATTEMPT           dispatch to head   │
          │                               │
     ┌────┴─────┐                         │
     │          │                         │
  success   retryable failure ────────────┘ next candidate,
     │      (429 / 5xx / connect)           bounded attempts
     │          │
     │          └──▶ 6. CIRCUIT BREAKER  cooling_down until reset,
     ▼                                    or exhausted (no timer)
  response (streamed byte-for-byte on the passthrough path)
```

| Step | Input | Output | Pure? |
|---|---|---|---|
| 1 Resolve scope | key | `all` / pool set / account set | yes |
| 2 Intersect | scope + pool membership | candidate accounts | yes |
| 3 Filter | candidates + health snapshot + requested model | eligible accounts | yes |
| 4 Policy | eligible accounts + session key + **existing Session → Account binding** + policy | ordered list | yes |
| 5 Attempt | ordered list | response, or next attempt | no (I/O) |
| 6 Circuit breaker | failure + parsed rate-limit signal | new health state | yes |

Step 4 takes any existing Session → Account binding as an input because on the Claude subscription
path that binding is authoritative, not a preference — see
[`sticky`](#sticky-default--session-affinity) below. It stays a pure function: the binding arrives
in the snapshot like everything else.

Every step but 5 is a **pure function over an injected health snapshot**. No clock, no store, no
network — the clock and the snapshot are arguments. That is what makes routing unit-testable with
zero mocks: build a snapshot, call the function, assert the choice.

**It is also what keeps it cheap.** The router is in the hot path of every request every
developer and every agent makes, so selection is held to a hard overhead budget: the math is
allocation-light (rendezvous hashing over a small candidate array), does **no I/O**, and takes
**no locks on the read path**. Account health and quota state are served from in-memory caches
kept warm by upstream responses and the scheduler — **never a database query on the critical
path**. See [09-deployment.md](09-deployment.md) for the budget and the
`router_overhead_seconds` metric that guards it.

## Scope intersection — before anything else

The presenting key's scope (`all`, one or more Pools, or an explicit Account list — see
[04-api-keys-and-access.md](04-api-keys-and-access.md)) is applied **first**, and it is an
**intersection**, never a union:

```
candidates = pool_members ∩ key_scope
```

| Rule | Statement |
|---|---|
| Both must admit | An Account is a candidate only if the pool contains it *and* the key's scope allows it. |
| Never widened | No policy, no failover step, no "everything else is down" condition ever reaches outside the scope. There is no setting that relaxes it. |
| Precedes policy | The policy in step 4 only ever sees in-scope accounts, so it cannot prefer one that isn't. |
| Empty means error | An empty intersection is a clear, specific failure naming the reason — never a silent fallback to a broader set. Codes below. |

A key scoped to explicit Accounts ignores pool membership entirely; that list *is* the candidate
set, and the pool's policy still orders it.

## Candidate filtering

Of the in-scope candidates, an account survives only if **all** of these hold:

| Rule | Dropped when |
|---|---|
| **Active** | status is `disabled`, `needs_reauth`, `cooling_down`, or `exhausted` |
| **Not cooling down** | the breaker's reset instant is still in the future |
| **Not out of credits** | the account is `exhausted` — a hard stop with no timer, see below |
| **Quota headroom** | a live quota signal reports the relevant window exhausted (see [03-providers.md](03-providers.md)) |
| **Supports the model** | the account declares an explicit model set and the requested model — after alias mapping — is not in it |

An account with **no** declared model set supports everything: unknown means passthrough, not
exclusion. Filtering never falls back to "try it anyway" — an empty candidate set is an honest,
specific error, and which error depends on *why* it is empty.

## The six load-balancing policies

**This is the centerpiece.** A Pool exists so that N accounts of the same kind behave like one
larger, more reliable account, and the policy is the mechanism that makes that true. Six of them,
each a different answer to "spread the load how?" — and the default answer is *not* "evenly",
because on Claude subscription pools even spreading is not merely wasteful, it is **incorrect**:
an Agent-SDK session is resumable only on the Account that created it.

> **Read this before choosing a policy.** On pools containing `anthropic-oauth` (Claude
> subscription) Accounts, `round-robin`, `weighted`, and `least-used` are **unsafe as-is** — they
> ignore session identity, and moving a Session to another Account does not cost a cache, it breaks
> the conversation. They are safe only where they respect an existing Session → Account binding.
> See [`sticky`](#sticky-default--session-affinity) below and
> [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §4.

### `sticky` (default) — session affinity

Assigns a session to an account by **rendezvous hashing** (highest random weight): score every
candidate as `hash(session_key ‖ account_id)`, take the highest. The session's account is
whichever candidate wins that comparison.

**The session key**, derived per [02-domain-model.md](02-domain-model.md):

| Order | Source |
|---|---|
| 1 | A **client-supplied session header**, when the client sends one. Authoritative — the client knows its own conversation boundaries better than we can infer them. |
| 2 | Otherwise a **fingerprint** of the first user message plus the working directory. Stable across the turns of one conversation, distinct between two conversations started in different projects. |

Sessions are ephemeral and expire on a TTL (see [09-deployment.md](09-deployment.md)); an expired
session simply re-derives and re-hashes, landing on the same account as long as the candidate set
is unchanged.

| Property | Consequence |
|---|---|
| Deterministic | The same session and the same candidate set always produce the same account. |
| **Restart-safe with no stored map** | Stickiness is recomputed, not remembered — for *placement*. Nothing to persist, lose, or corrupt across restarts. On the SDK path this covers only where a new Session lands: the binding of an existing Session is persisted, because a recomputed guess cannot resume an id another Account owns. |
| Minimal disruption | Adding an account only moves the sessions that hash to it; removing one only reassigns *that* account's sessions. Everything else stays put. On the SDK path, bound Sessions do not move at all — they stay put until their binding is invalidated. |
| Self-healing | If an account is filtered out (cooling down, exhausted), a new session lands on the next-highest scorer and returns when the account recovers. For a *bound* SDK session this is not free: landing elsewhere means the binding was invalidated and the conversation restarts. |

**Why it is the default — the primary reason is correctness, not economics.**

On the **Claude subscription path** ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)),
requests are served through the Claude Agent SDK, which is *stateful*: the upstream conversation
lives in an SDK session id, and **that id is resumable only on the Account that created it.** Move
a Session to a different Account and the conversation cannot be resumed **at all** — the second
Account has never heard of it. This is not a slower path. It is a broken one.

The cache argument is real but **secondary**: prompt caching is per-account, so an account that has
seen a conversation before serves its next turn warm while a different one must be re-sent the
entire context and charged for it. On the plain HTTP path that is the *whole* cost of hopping —
slower first token, more tokens billed, but a correct answer. On the SDK path there is no answer.

Sticky routing spreads *sessions* across all five Claude subs while pinning each individual
conversation to one of them: the pool is balanced, every conversation stays warm, and every
conversation stays resumable.

#### The Session → Account binding is authoritative state, not a hint

On the SDK path the binding is **persisted and load-bearing** (see
[02-domain-model.md](02-domain-model.md#session)), not a routing preference that a policy may
overrule:

| Rule | Statement |
|---|---|
| **Binding wins over policy** | If a live Session already has an Account, that Account is the choice — for any policy. The policy only ever selects for a Session with no binding yet, or one whose binding was invalidated. |
| **Moving is not an option** | There is no operation that carries a Session from one Account to another. A policy that would move an in-flight Session must instead **invalidate the mapping and start a fresh upstream session** on the new Account. |
| **Say so, don't fake it** | A restarted session has lost every prior turn. The router surfaces that — it does **not** silently truncate context, replay a flattened transcript as if it were the real history, or let the client believe the conversation continued. |
| **Rendezvous is the tiebreak, not the truth** | Hashing decides where a *new* Session lands, and re-derives the same answer after a restart. Where a binding exists, the binding is the truth, because only the storing Account can resume the id. |

On the plain **HTTP path** (`anthropic-api`, `openai-api`, OpenRouter, z.ai, …) none of this
applies: every request carries its full history, so stickiness there is purely the cache
optimization it has always been, and hopping accounts is safe.

Trade-off: distribution is even in expectation, not exactly. One heavy session can make its
account the busiest. `least-used` trades that away — but see the warning above before using it on
a Claude subscription pool.

### `round-robin`

Even rotation across the eligible candidates, one request at a time, ignoring session identity.

| When to use | Trade-off |
|---|---|
| Homogeneous accounts, short stateless requests, or when you want the flattest possible spread. | **Destroys cache affinity.** A multi-turn conversation hits a different account every turn and pays a cold cache each time. **Unsafe as-is on Claude subscription pools** — there a hop is not a cold cache, it is an unresumable conversation. Safe only if it respects an existing Session → Account binding. |

### `weighted`

Round-robin biased by each Account's `weight`. An account with weight 3 gets roughly three times
the share of one with weight 1.

| When to use | Trade-off |
|---|---|
| Accounts of unequal capacity — a Max 20x sub alongside two Pro subs; a fast local endpoint alongside a slow remote one. | Weights are a static guess. They do not react to live load or quota; that is `least-used` and `quota-aware`. Same cache-affinity loss as round-robin — and the same **unsafe-as-is on Claude subscription pools** caveat, for the same reason. |

### `least-used`

Picks the candidate with the lowest current load: fewest in-flight requests, or lowest recent
token spend. **DEFERRED**: which of the two is the default measure, and the exact window.

| When to use | Trade-off |
|---|---|
| Bursty traffic with wildly uneven request sizes, where a flat rotation still leaves one account buried. | Reactive, so it can oscillate under rapid churn. No affinity — same cold-cache cost, and the same **unsafe-as-is on Claude subscription pools** caveat. Oscillation makes it the worst of the three there: it can move a Session mid-conversation on a load blip. |

### `priority-failover`

Strict order by each Account's `priority`. Always take the highest-priority eligible account;
descend **only** when everything above it is filtered out.

| When to use | Trade-off |
|---|---|
| "Burn the subscription first, fall back to the paid API." Also: prefer a local endpoint, fall back to a hosted one. | Deliberately **not** load balancing. Account #1 absorbs everything until it is exhausted or cooling down. Concentrates load, and concentrates blast radius. |

Ties in priority fall back to the pool's declared order. This is the policy where "many accounts
of the same provider" pays off most: order five Claude subs 1–5 and the pool drains them in
sequence, one quota window at a time, before ever touching a metered account.

### `quota-aware`

Prefers the eligible account with the **most remaining subscription headroom**. Ranking accounts by
headroom requires a **continuous** signal — a gauge that reads a real percentage at any point in the
window. Not every quota signal is one, and the distinction decides whether this policy works at all:

| Signal kind | Reads | Usable for ranking |
|---|---|---|
| **Continuous** | a real percentage for every window, at any time | **Yes.** This is what `quota-aware` needs. |
| **Threshold-triggered** | nothing until consumption crosses a threshold near the limit, then a value | **No.** It is an *alarm*, not a gauge — perfect for the circuit breaker, useless for ranking. |

For `anthropic-oauth` (Claude subscriptions) that distinction is the whole story:

| Source | Kind | Role |
|---|---|---|
| SDK `rate_limit_event` stream events (`status`, `resetsAt`, `rateLimitType`, `utilization`) | **threshold-triggered** — `utilization` is populated **only near the limit** | Circuit breaker and cooldown timing. Free: it rides responses we are already making. **Not sufficient for `quota-aware`.** |
| `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`) | **continuous** — a percentage per active window, always | **Required for `quota-aware` to mean anything** on Claude subscription accounts. |

**State it plainly: without the OAuth usage endpoint, `quota-aware` degrades to round-robin.** For
most of a window every Claude subscription account reports `null` headroom, every candidate ties,
and the tiebreak is an arbitrary rotation — with round-robin's cache and affinity costs and none of
its honesty about what it is doing. The endpoint is not an optimization on this path; it is the
signal. Windows: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage` — the
last one is recorded state, never a block on its own: a rejected paid top-up says nothing about an
included window that is still serving requests, and only the window that refused does. Merge rule, cache
TTLs, and last-good-snapshot behavior are in
[11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §5; see also
[03-providers.md](03-providers.md).

| When to use | Trade-off |
|---|---|
| A pool of several subscriptions of the same kind, where the goal is to keep all of them usable rather than drain one — **and** a continuous quota signal is available for them. | Only as good as the provider's signal, and *only* a continuous one counts. Accounts whose provider exposes nothing continuous rank as unknown-headroom and fall back to round-robin among themselves. Signals are cached on a short TTL, so the view can be seconds stale. No affinity — the same Claude-subscription binding caveat as round-robin applies whenever headroom ranking would move a bound Session. |

### Comparison

| Policy | Session affinity | Spreads load | Safe on a Claude subscription pool? | Best for |
|---|---|---|---|---|
| `sticky` | **yes** | evenly, per session | **Yes** — it is the reason the binding holds | the default — many subs, multi-turn conversations, warm caches |
| `round-robin` | no | evenly, per request | **No, unsafe as-is** — moves Sessions, breaking resume | homogeneous accounts, stateless calls |
| `weighted` | no | proportionally | **No, unsafe as-is** — same reason | accounts of unequal capacity |
| `least-used` | no | reactively | **No, unsafe as-is** — worst of the three, it can move a Session on a load blip | bursty, uneven request sizes |
| `priority-failover` | incidental | **no — concentrates** | Yes in practice — it holds a Session on the top account until that account is filtered out | burn the subscription first, pay per token last |
| `quota-aware` | no | by remaining headroom | Only while it respects an existing binding — **and** only useful with a continuous quota signal | keeping several subscriptions alive together |

"Unsafe as-is" means exactly one thing: the policy selects an Account **ignoring** any existing
Session → Account binding. On the HTTP path that costs a cold cache. On the Claude subscription
path it makes the conversation unresumable. A pool mixing both kinds of Account is judged by its
SDK-path members. Where such a policy is offered on a subscription pool at all, it must be
binding-respecting: the policy chooses only for unbound Sessions.

Policy is set **per Pool**. A key scoped to two pools gets each pool's own policy applied within
that pool — the policy never runs across the union.

## Failover

| Condition | Action |
|---|---|
| `429` | Retry the next candidate. Mark the account `cooling_down` until its reset. |
| `402`, or an out-of-credits / billing error body | Retry the next candidate. Mark the account **`exhausted`** — no timer, no automatic retry. See below. |
| `5xx` | Retry the next candidate. Count toward the breaker's failure streak. |
| Connection failure / timeout | Retry the next candidate. Count toward the failure streak. |
| `4xx` other than `429` | **Do not retry.** A bad request is bad at every account; returning the upstream's error is the honest answer. |
| `401` / `403` | Do not retry. Move the account to `needs_reauth` (OAuth) or `disabled` (an API key, or a no-auth endpoint that has grown something in front of it — neither has a login to re-run) and surface it. |

Rules:

- **Attempts are bounded** — a small fixed cap, well under the candidate count, so a broken pool
  fails fast instead of walking every account. Exact cap is configuration.
- **Each attempt is a distinct account.** Never retry the same account inside one request.
- **Once bytes have been streamed to the client, the request fails honestly.** No silent restart.
  Replaying a partially delivered stream would produce a response the client cannot reconcile —
  duplicated tokens, a second `message_start`, a tool call emitted twice. The router surfaces the
  truncation as an error and lets the client decide. This is a hard rule, not a tunable.
- The failure that surfaces is the **last** attempt's, with the attempt count in the error
  metadata and in the `UsageRecord`.

### Failover mid-conversation — the two paths are not the same operation

Retrying "the next candidate" means something different depending on how the Account is served.
**Do not assume the HTTP behavior on the SDK path.**

| | **HTTP path** (`anthropic-api`, `openai-api`, OpenRouter, z.ai, Kimi, …) | **SDK path** (`anthropic-oauth`, Claude subscriptions) |
|---|---|---|
| What upstream holds | Nothing. Every request carries its full history. | The conversation, behind an SDK session id owned by **one** Account. |
| Retrying elsewhere | Re-send the same request to another account. | The other Account cannot resume the id. There is nothing to re-send *as a continuation*. |
| Cost of the hop | A cold prompt cache. | The prior turns, unless the client resends them. |
| Client-visible | **Transparent.** Same request, same answer, one extra hop of latency. | **Not transparent.** The binding is invalidated and a **fresh upstream session** starts on the new Account. |
| Session state after | Unchanged — stickiness is a preference. | Mapping dropped; a new `sdkSessionId` is created on the new Account and bound to the Session. |

Rules specific to the SDK path:

| Rule | Statement |
|---|---|
| **Invalidate, never migrate** | Failing over drops the Session → Account mapping. The router never carries an `sdkSessionId` to another Account, and never retries a `resume` against one. |
| **Be honest about the restart** | The router surfaces that prior turns are gone rather than silently continuing with truncated context or replaying a flattened transcript as if it were the real conversation. |
| **A stale session is not a failover** | `No conversation found with session ID` on the *same* Account evicts the mapping and replays once there ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §9). That is recovery in place, not a hop to another Account. |
| **The streaming rule still dominates** | Once bytes are on the wire, nothing is retried on either path. A restart is only ever possible before the first byte. |

Everything above the failover step is unchanged: scope intersection, filtering, and the bounded
attempt cap apply identically to both paths.

## Circuit breaker

| State | Meaning | Exit |
|---|---|---|
| `active` | Eligible for selection. | — |
| `cooling_down` | Excluded from the candidate set. Temporary — a clock will fix it. | Reset instant passes, then a half-open probe. |
| half-open | One request is allowed through as a probe. | Success → `active`. Failure → `cooling_down` with the next backoff step. |
| `exhausted` | Excluded from the candidate set. **Permanent until a human acts** — the breaker never schedules a retry. | An operator tops up / fixes billing, then a manual re-check or a successful probe returns it to `active`. |

| Backoff source | Used when |
|---|---|
| **Provider-reported reset** | The response carries a reset instant (rate-limit header, or a quota window's `resets_at`). Always preferred — it is the truth. |
| **Exponential backoff** | Nothing is reported. Grows per consecutive failure, jittered, capped. Resets to the floor on the first success. |

Breaker state is in-memory routing hygiene, not durable truth: after a restart the first failing
request re-marks. It expires with its own reset window (see the retention table in
[09-deployment.md](09-deployment.md)). A later mark may extend an entry; an
earlier one never shortens it, so two concurrent failures cannot un-learn the longer reset.

### Health signals feeding it

| Signal | Source |
|---|---|
| Rate-limit headers and reset instants | `parseRateLimit` on every upstream response |
| Subscription quota windows and utilization | Two kinds, never conflated. **Threshold-triggered**: the SDK's `rate_limit_event` events for Claude subs — fires only near the limit, so it is what trips the breaker but cannot rank headroom. **Continuous**: provider usage endpoints (Anthropic's OAuth usage endpoint for Claude subs, equivalents elsewhere) — a real percentage at any time, and the only thing `quota-aware` can rank on. Short-TTL cached, deduped per account |
| Consecutive failure streak | attempt outcomes |
| Auth failures | `401`/`403` → `needs_reauth` / `disabled`, not a cooldown |
| Balance / credit signals | `402` and provider-specific out-of-credits bodies → `exhausted` |
| Latency and error rate | `UsageRecord` rollups — see [08-observability.md](08-observability.md) |

All of it is folded into one **health snapshot**, held in memory, which is the only thing the
pure selection functions read.

## Running out — two different failures, never conflated

"The account stopped working" has two causes with nothing in common, and treating them alike is
the mistake that makes a pool look broken when it is fine, or fine when it is broken.

| Condition | Meaning | Status | Recovery |
|---|---|---|---|
| **Rate limited / quota window hit** | Temporary. A subscription's 5-hour or 7-day window is spent; it refills on a clock. | `cooling_down` | Automatic at the reported reset time; a half-open probe confirms. |
| **Out of credits / balance exhausted** | Hard stop. A prepaid balance (OpenRouter, z.ai, Kimi, MiniMax) hit zero, a billing account went away (Gemini), a plan expired, or billing failed. **No clock will fix it.** | `exhausted` | **Human action only** — top up, fix billing, replace the key. The router never retries it on a timer. |

Rules:

| Rule | Statement |
|---|---|
| **Detect, don't guess** | The classification comes from the upstream signal — status code plus the provider's error body. This is a **driver-level** concern ([03-providers.md](03-providers.md)), because every provider words it differently. The router records *which* signal produced the classification, so a misclassification is debuggable. |
| **Remove immediately** | An `exhausted` account leaves every candidate set at once, for every key and every pool. |
| **Surface loudly** | `exhausted` gets a **red banner on the dashboard**, not a status buried on a detail page. This is the failure an operator most needs to see, because it silently shrinks the pool while everything still appears to work. |
| **Warn before it dies** | Where a provider exposes a balance at all, a low-balance threshold flags the account *before* it hits zero. |

### When every candidate is unavailable

Fail honestly and specifically. The error names the actual condition — "all 4 accounts in pool
`team` are rate limited, earliest reset 14:32Z", "all accounts out of credits" — and the status
code follows the cause:

| Cause | Status | Body carries |
|---|---|---|
| Everything `cooling_down` / rate limited | **`429`** with `Retry-After` | earliest reset instant across the candidates |
| Everything `exhausted` / billing failed | **`402`** | which accounts need a top-up |
| Nothing configured, or nothing in the key's scope | **`403`** | the scope that resolved empty |
| Mixed causes | the code for the **soonest recoverable** one, `429` if any account has a reset | per-account breakdown |

Never a generic upstream `500`. Never a silent fallback outside the key's scope.

### Overflow (optional, opt-in)

A Pool may designate one **overflow Account** — typically a paid API key — used **only** when
every primary member is cooling down or exhausted.

| Property | Value |
|---|---|
| Default | **Off.** Spending real money is opted into, never inferred. |
| Trigger | The primary candidate set is empty *after* filtering. Not on a single 429, not on latency. |
| Scope | Still subject to the key's scope — an overflow account outside the key's scope is not used. |
| Visibility | Every overflow-served request is marked as such in its `UsageRecord`, so "why did we spend money last night" has an answer. |

Overflow is distinct from `priority-failover`: that policy orders the pool's own members;
overflow is a member of last resort that is otherwise invisible to the policy.

## Reset visibility and manual re-check

The operator's two questions when a pool degrades are *"when does it come back?"* and *"is it
back yet?"* Both are answerable in the UI, without reading logs.

**Every unavailable Account carries a reset timestamp**, shown as an absolute local time *and* a
live countdown — "resets 14:32, in 47 min". The source of that timestamp is **labeled**, because
a guessed reset presented as fact is worse than no reset at all:

| Source | Shown as | Where it comes from |
|---|---|---|
| **Provider-reported** | the time, plainly | `resetsAt` on a Claude `rate_limit_event`, a `Retry-After` header, or a provider-specific field. The truth; always preferred. |
| **Computed estimate** | the time, explicitly marked an estimate | derived from the window type when the provider reported nothing. |
| **Unknown** | "unknown — will retry with backoff" | nothing reported and nothing inferable. No invented number. |

**Per-window breakdown, not one number.** A Claude subscription runs several concurrent windows —
5-hour, 7-day, and the per-model 7-day windows — that **reset independently**. Each is shown with
its own utilization and its own reset time; the account is blocked by whichever is exhausted, and
the UI says which.

**Label the signal kind next to the number.** A utilization figure sourced from a
**threshold-triggered** signal (the SDK's `rate_limit_event`) is absent for most of a window by
design — an empty gauge there means "nothing near the limit", not "no data" and not "broken". A
figure from a **continuous** signal (the OAuth usage endpoint) is a real reading at any time.
Showing both as an identical bar makes a correct empty gauge look like a fault, and makes a missing
continuous signal invisible — the one case an operator needs to act on, because `quota-aware`
silently stops working without it.

**`exhausted` has no reset.** That absence is exactly what distinguishes it from `cooling_down`.
Display **"needs top-up"**, never a countdown, and never invent an ETA.

### "Re-check now"

A button, per account and for all accounts at once. Providers sometimes reset early, lift a limit
for everyone, or restore a balance out of band — **the router must not sit on a stale clock it
computed itself** while capacity is available.

| Property | Behavior |
|---|---|
| What it does | Re-queries the provider's live quota/usage signal, updates utilization and reset times, and returns the account to `active` immediately if it is healthy again. |
| Throttled | A short **server-side** per-account cooldown between manual checks, so the button cannot hammer a provider. |
| Inline outcome | "still limited, resets 14:32" / "back online" / "still out of credits" — shown next to the button. |
| Last checked | Always visible, whether the last check was manual or automatic. |
| **One code path** | It is the *same* probe the circuit breaker runs on its half-open transition, triggered manually. Not a second implementation — there is exactly one way to ask a provider "are you back?". |

Reset instants and utilization are also exposed on the API so an operator can alert on them
externally; see [08-observability.md](08-observability.md).

### "Test now"

A second, distinct button, per account. **Re-check now sends nothing** — it re-queries a quota
signal and clears breaker marks, so it can never answer "does this credential actually complete a
request?" Test now answers exactly that: it addresses this one account directly, bypassing pool
membership, key scope, and failover, and sends the smallest real completion the account's dialect
can make.

| Property | Behavior |
|---|---|
| What it does | One real, minimal completion (capped output) against this account's own credential, via the exact same attempt path a live request takes — same headers, same failure classification. |
| Cost | Real, every time. An HTTP account spends a token or two of a real quota window; a Claude subscription spends a turn **and** spawns a `claude` subprocess. |
| Confirmation | The Agent-SDK path refuses to run without an explicit `confirmed: true` on the request — the console shows a confirmation dialog naming the subprocess and the spend before it ever fires. Every other provider's press goes straight through. |
| Throttled | Its own **server-side** per-account cooldown, longer than Re-check now's and never shared with it — a free button's presses must never spend a paid one's window, or the reverse. |
| Model | The operator names it, same as a client would; the router keeps no model catalog for an upstream to guess from. |
| Outcome | `ok` or `failed`, plus a short, safe message — a router-authored sentence, the account's own one-word reply, or a failure signal, never a raw upstream body or credential material. |
| No fan-out | There is no all-accounts form. A button that spends a real request — and on the Agent-SDK path a subprocess — per account in a pool is not one this console offers. |

## Worked example

Pool `default`, policy `priority-failover`. Four accounts — note that three are the *same
provider*:

| Priority | Label | Provider | Kind |
|---|---|---|---|
| 1 | `claude-a` | `anthropic-oauth` | Max subscription |
| 2 | `claude-b` | `anthropic-oauth` | Max subscription |
| 3 | `claude-c` | `anthropic-oauth` | Max subscription |
| 4 | `openrouter-1` | `openrouter` | metered API key |

| Time | Event | Candidate set after filter | Serves | Note |
|---|---|---|---|---|
| T0 | Steady traffic | a, b, c, or-1 | **claude-a** | Strict order. b and c sit idle by design. |
| T1 | `claude-a` five-hour window hits 100% | b, c, or-1 | **claude-b** | Quota signal filtered a out *before* any 429. Zero failed requests. `cooling_down`, with a countdown from the provider-reported `resetsAt`. |
| T2 | `claude-b` returns `429` with a reset instant | c, or-1 | **claude-c** | The 429'd request retried onto c and succeeded. b is `cooling_down` until the reported reset. |
| T3 | `claude-c` seven-day Opus window exhausts | c (for Sonnet), or-1 | **claude-c** for Sonnet, **openrouter-1** for Opus | Filtering is per requested model *and* per window — c's 5-hour and 7-day-Sonnet windows are still healthy, so c keeps serving what it can. |
| T4 | `claude-c` exhausts every window | or-1 | **openrouter-1** | The pool is now spending money. Exactly the intent: subscriptions first. |
| T5 | `openrouter-1` returns `402` / out-of-credits | ∅ | — | or-1 becomes **`exhausted`**, not `cooling_down` — red banner, "needs top-up", no countdown. a/b/c are still cooling, so the request fails **`429` + `Retry-After`** naming a's reset: the soonest recoverable cause. Never a `500`, never a hop outside the key's scope. |
| T6 | `claude-a`'s window resets | a | **claude-a** | Highest priority is eligible again; the pool climbs straight back to free capacity. `openrouter-1` stays `exhausted` until a human tops it up — no timer will do it. |
| T7 | Operator hits **Re-check now** on `claude-b` | a, b | **claude-a** (priority) | The provider lifted the limit early. b returns to `active` immediately instead of waiting out a clock the router computed for itself. |

Two variations on the same four accounts:

- **Policy.** Swap to `quota-aware` and traffic tracks whichever of a/b/c has the most headroom
  instead of draining `claude-a` to zero — keeping all three usable and deferring
  `openrouter-1` for longer. **Two conditions.** It needs a *continuous* headroom reading for
  a/b/c — the OAuth usage endpoint, since the SDK's events say nothing until a window is nearly
  spent — or the three tie at unknown and the pool rotates instead of ranking. And because a, b,
  and c are subscription accounts, the policy may only re-rank Sessions that are **unbound**; an
  in-flight conversation stays on its Account until its binding is invalidated.
- **Key scope.** A key scoped to `[claude-a]` only never sees b, c, or or-1. At T1 its candidate
  set is empty and it gets `429` + `Retry-After` — it does **not** fall through to `claude-b`,
  even though `claude-b` is healthy and in the same pool. That is the scope guarantee working
  as designed, not a bug.

## Testability

| Property | Consequence |
|---|---|
| Health is an **injected snapshot**, not a live lookup | Construct any pool state in a test literal. |
| The clock is **injected** | Cooldowns, resets, and backoff are tested without waiting. |
| Selection is **pure** | Same inputs, same account. No mocks, no fakes, no network, no DB. |
| Rendezvous hashing is **pinned** | A set of `(session, accounts) → expected account` triples is asserted against hard-coded literals. If the hash changes, every *unbound* session reshuffles onto a cold cache on upgrade — a breaking change with a migration note, not a test to update casually. Persisted SDK-path bindings are what stops the same change from breaking live conversations outright, which is precisely why they are stored rather than recomputed. |
| The Session → Account binding is **an input, not a side effect** | Selection receives the existing binding in its snapshot and returns the same Account, or returns "invalidate and rebind" — both assertable in a pure test, with no SDK and no subprocess. |
| I/O lives only in step 5 | Integration tests cover dispatch and streaming; unit tests cover every decision. |

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Where selection sits in the request lifecycle |
| [02-domain-model.md](02-domain-model.md) | Pool, Account, Session field definitions and state machines |
| [03-providers.md](03-providers.md) | Where quota and rate-limit signals come from, per provider |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | Why the Session → Account binding is load-bearing (§4), and which quota signals are continuous vs. threshold-triggered (§5) |
| [04-api-keys-and-access.md](04-api-keys-and-access.md) | Key scope — how a key resolves to a candidate set |
| [06-protocol-translation.md](06-protocol-translation.md) | What happens to the request once an account is chosen |
| [08-observability.md](08-observability.md) | Usage records, health surfaces, metrics |
