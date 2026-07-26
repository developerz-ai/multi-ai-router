# Domain model

Status: **the Drizzle schema in `packages/db` exists and is the authority.** The field lists below
are the design contract behind it — types are intent (`string`, `enum`, `json`), not column
definitions, and a column name may differ where the schema found a better one. Where the two
disagree, the schema wins and this page is the bug. Account, Pool, ApiKey, UsageRecord, and
AuditEvent are live; Session, QuotaWindow, ScheduledTaskRun, and OauthState have tables that
nothing writes yet. See [01-architecture.md](01-architecture.md) for where each entity lives in the
layering.

## Entity relations

```
   Provider  (static, code-defined registry — not a table)
      │ 1
      │        MANY Accounts per Provider is the normal case:
      │ many   5× claude-max, 3× zai, 2× openai-oauth, side by side
      ▼
   Account ──────────┐ many
      ▲ many         │
      │              │  (membership: weight, priority within the pool)
      │ many         ▼
      └──────────  Pool
                     ▲ many
                     │
                     │ many
                  ApiKey  (scope: `all` skips Pools; `accounts` binds Accounts directly)
                     │
                     │ 1
                     ▼ many
   Session ────────▶ Account    binding: authoritative + persisted on the SDK path,
                                recomputed by hashing on the plain HTTP path

   UsageRecord ──▶ ApiKey       (which key spent it)
        ├───────▶ Account       (which upstream served it)
        └───────▶ Session       (which conversation it belonged to)

   AuditEvent  (append-only, admin plane only, no relations required)

   ScheduledTaskRun  (append-only, one row per periodic-task run, no relations required)
```

Cardinality summary: `Provider 1→many Account`, `Account many↔many Pool`,
`ApiKey many↔many Pool`, `UsageRecord many→1 ApiKey / Account / Session`,
`Session many→1 Account` (at most one at a time — a Session is never bound to two Accounts, and on
the SDK path it is never moved between them).

## Provider

A *kind* of upstream. Static registry, code-defined — there is no provider table and no admin CRUD
for it. Adding one is a code change; see [03-providers.md](03-providers.md).

| Field | Type | Notes |
|---|---|---|
| `id` | enum | `anthropic-oauth`, `anthropic-api`, `openai-oauth`, `openai-api`, `openrouter`, `zai`, `kimi`, `minimax`, `gemini`, `groq`, `deepseek`, `xai`, `mistral`, `together`, `cerebras`, `ollama`, `openai-compatible`, `anthropic-compatible` |
| `dialect` | enum | Native wire protocol the driver speaks; drives passthrough vs. translation |
| `authKind` | enum | `oauth` (refreshable), `api-key` (valid until revoked upstream), or `none` (a local endpoint that authenticates nobody — the credential is optional, and its **absence** is what this value permits) |
| `constants` | code | Endpoints, client id, scopes, required headers — pinned in one file per provider |

## Account

One credential to one Provider. **Many Accounts per Provider is the normal case, not an edge case** —
five Claude Max subscriptions, three z.ai keys, and two ChatGPT subs sitting side by side in one pool
is the entire point of the product: pooling several accounts *of the same kind* is what makes load
balancing and failover worth having. Nothing in the model, the UI, or the routing may assume one
account per provider. The `label` is what distinguishes them to a human.

| Field | Type | Notes |
|---|---|---|
| `id` | id | Stable across reconnects — a `needs_reauth` account keeps its id, pool membership, and usage history |
| `label` | string | Required, human-chosen. The disambiguator between same-provider accounts: `claude-max-seb`, `claude-max-team-2` |
| `provider` | enum | Provider id |
| `authMaterial` | encrypted blob | API key, or OAuth access + refresh token. AES-256-GCM. Never returned by any endpoint. **Empty for Claude subscription accounts** — those hold a `CLAUDE_CONFIG_DIR` path instead, and the SDK owns the credentials inside it ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)). Also legitimately empty for an `authKind: none` provider (`ollama`), whose upstream authenticates nobody; the request then carries no auth header, and every other provider's empty account is refused at write time |
| `configDir` | path, optional | Claude subscription accounts only. One isolated `CLAUDE_CONFIG_DIR` per Account so N subscriptions coexist without cross-contamination. Its contents are live credential material. **Assigned by the router, never by the operator**: `<CLAUDE_CONFIG_ROOT>/<id>`, created `0700` with the row and deleted with it. Keyed on `id` because a `label` is renameable and a rename would strand a logged-in directory; a unique index on the column makes "two Accounts, one directory" a write that cannot land |
| `tokenExpiresAt` | timestamp, optional | OAuth accounts only. Drives the per-account refresh schedule; refresh fires at a fraction of the remaining lifetime, never on a `401`, and is re-scheduled each time a new token lands |
| `refreshState` | in-memory | This account's armed timer and its single-flight guard: every trigger for one account awaits one shared promise, never N racing writes. Plus the backoff counter for failed refreshes. A *request* is never a trigger — it neither starts nor waits on a refresh |
| `status` | enum | `active` \| `disabled` \| `cooling_down` \| `exhausted` \| `needs_reauth` |
| *(quota windows)* | separate `quota_windows` table | Per-window quota state — see below. A Claude subscription has several concurrent windows that reset independently, so they are rows keyed `(account_id, window)`, not a JSON blob on the account: each window is upserted and expires on its own clock, and one refresh must not rewrite the others |
| `modelAliases` | json, optional | Maps the client's model name to the account's (`sonnet` → `glm-4.7`, `sonnet` → `k3`). Absent means pass the name through unchanged |
| `weight` | number | Bias for the `weighted` policy |
| `priority` | number | Strict order for the `priority-failover` policy |
| `health` | in-memory | Cooldown expiry, recent failures, in-flight count, quota headroom. Snapshotted and injected into selection |

**Which accounts have a refresh lifecycle at all.** `tokenExpiresAt` and `refreshState` exist only
for accounts the router refreshes: non-Anthropic OAuth subscriptions (ChatGPT/Codex today).
API-key accounts have neither — they are valid until revoked upstream. **Claude subscription
accounts have neither either**: their tokens live in `configDir` and are refreshed by the Agent SDK,
so the router has no token lifecycle to model, schedule, or persist for them. It only observes an
SDK-reported auth failure and sets `needs_reauth`. Refresh is expiry-driven and single-flighted,
never a poll — see [01-architecture.md](01-architecture.md#credential-refresh-is-not-a-cron-job).

### Quota window state

One entry per window, because windows reset independently and the account is blocked by whichever
one is spent. The operator's questions are "when does it come back?" and "is it back yet?", so the
model carries the answer *and* how trustworthy it is.

| Field | Type | Notes |
|---|---|---|
| `window` | enum | `five_hour` \| `seven_day` \| `seven_day_opus` \| `seven_day_sonnet` \| provider-specific |
| `utilization` | number, **optional** | Fraction of the window consumed. Optional on purpose: a threshold-triggered source reports nothing until consumption nears the limit, so `null` is a normal reading for most of a window, not a fault |
| `utilizationSource` | enum | `continuous` (a usage endpoint that returns a real percentage at any time — Anthropic's OAuth usage endpoint for Claude subs) \| `threshold-triggered` (an alarm that fires only near the limit — the SDK's `rate_limit_event`) \| `none`. **Always carried, and displayed with the gauge** — see below |
| `resetsAt` | timestamp, optional | When this window refills. Rendered as an absolute time *and* a live countdown |
| `resetSource` | enum | `provider-reported` (SDK `rate_limit_event`, `Retry-After`, provider field) \| `estimated` (computed from the window type) \| `unknown` (backoff only). **Always displayed** — a guessed reset shown as fact is worse than no reset |
| `lastCheckedAt` | timestamp | When this state was last refreshed, by the half-open probe or the operator's "Re-check now" |

**Continuous vs. threshold-triggered is a first-class distinction, not a provider detail.** The two
kinds are not interchangeable and the model must never flatten them into one number:

| Kind | Reads | Good for | Not good for |
|---|---|---|---|
| **Continuous** | a real percentage for every active window, at any point in it | ranking accounts by remaining headroom — the `quota-aware` policy; a UI gauge that means something all window long | — |
| **Threshold-triggered** | `null` until consumption crosses a threshold near the limit | tripping the circuit breaker, and it is free — it rides responses already being made | **ranking.** It is an alarm, not a gauge |

Two consequences carried by `utilizationSource`:

- **`quota-aware` needs a continuous source to mean anything.** With only threshold-triggered
  signals every candidate reads `null` for most of a window, they all tie, and the policy degrades
  to round-robin — see [05-routing-and-failover.md](05-routing-and-failover.md).
- **An empty gauge from a threshold-triggered source is correct and reads as broken.** Label it, or
  an operator debugs a working system — and, worse, cannot tell it apart from a *missing continuous
  signal*, which is the case that actually needs action.

An `exhausted` Account has **no** reset by definition — that is what separates it from
`cooling_down`. It carries a "needs top-up" state, never a countdown and never an invented ETA.

## Pool

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `name` | string | Human-chosen |
| `policy` | enum | `sticky` (default) \| `round-robin` \| `weighted` \| `least-used` \| `priority-failover` \| `quota-aware` — see [05-routing-and-failover.md](05-routing-and-failover.md). On a Pool containing Claude subscription Accounts, `round-robin` / `weighted` / `least-used` are **unsafe as-is**: they ignore the Session → Account binding, which on that path breaks the conversation rather than just the cache |
| `members` | Account[] | Ordered/weighted set. An Account may sit in several Pools |
| `overflowAccountId` | id, optional | The Pool's **member of last resort** — typically a paid API key — engaged only once every ordinary member has filtered out, and invisible to the policy until then. Still subject to the presenting key's scope. Absent means the Pool simply fails when its members are unavailable, which is the default: spending real money is opted into, never inferred. See [05-routing-and-failover.md](05-routing-and-failover.md#overflow-optional-opt-in) |

**Deleting the overflow Account clears the reference; it never deletes the Pool.**
`overflow_account_id` is `ON DELETE SET NULL` for exactly that reason — losing a fallback must
degrade the Pool to "no overflow", not destroy the Pool and every key bound to it. Membership is
the opposite case and cascades: a `pool_members` row has no meaning without both ends.

## ApiKey

Router-issued credential, `mar_live_…`. **Deliberately not a one-time-shown, hash-only key.** The
value is stored encrypted at rest (AES-256-GCM, the same `ENCRYPTION_KEY` as upstream credentials)
and the admin can view and copy it again at any time. Rationale: an operator running a fleet of
agents must be able to look a key up later without rotating it.

Verification path: indexed lookup by display prefix → decrypt → constant-time compare.

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `name` | string | **Required**, human-chosen: `sebastian-laptop`, `ci-agent-3` |
| `value` | encrypted | The full `mar_live_…` string. Retrievable by the admin at any time |
| `prefix` | string | Short display prefix, indexed — makes verification a lookup, not a table scan |
| `scope` | enum | `all` \| `pools` \| `accounts` — full vs. limited, see below |
| `scopeTargets` | Pool[] \| Account[] | The Pools or the explicit Accounts the scope names. Empty when the scope is `all` |
| `rateLimit` | config | Per-key request/token ceiling |
| `expiresAt` | timestamp, optional | |
| `revoked` | bool | Excluded from verification immediately |

### Key scope — full vs. limited

| Scope | Reaches | Use |
|---|---|---|
| `all` | Every active Account | The "trusted teammate" key |
| *pools* | The members of one or more Pools, inheriting each pool's routing policy | The normal case |
| *accounts* | An explicit list of Accounts, ignoring pool membership | "This CI agent may only ever burn the cheap OpenRouter key"; "this contractor's key touches exactly one sub" |

Scope is enforced at selection time: the candidate set is **always the intersection** of the pool's
members and the key's scope. A key can never reach an Account outside its scope, whatever the
routing policy would prefer, and a scope that resolves to an empty candidate set fails with an error
naming the reason — never a silent widening.

## Session

Conversation identity, used for routing and usage attribution. Retained on a TTL.

**On the Claude subscription (Agent-SDK) path the Session's Account binding is authoritative,
persisted state — not a sticky-routing hint.** An SDK session id is resumable **only** on the
Account that created it: another Account has never heard of it. So the binding is not a preference
that a policy may overrule and not a value that can be recomputed from a hash — it records a fact
about where the conversation physically lives upstream. See
[11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §4 and
[05-routing-and-failover.md](05-routing-and-failover.md).

| Field | Type | Notes |
|---|---|---|
| `key` | string | The session key — see derivation below |
| `apiKeyId` | id | Owning key |
| `accountId` | id, optional | **The binding.** On the SDK path: persisted, authoritative, and scoped to this Account — selection reads it as an input and returns it, rather than re-deriving a placement. Absent on the plain HTTP path, where placement is recomputed by rendezvous hashing and hopping is safe |
| `sdkSessionId` | string, optional | SDK path only. The upstream conversation id, meaningful **only** in the context of `accountId`. Never carried to another Account |
| `lineageState` | json, optional | SDK path only. Prefix hashes plus per-message SDK assistant UUIDs, used to classify the next request as continuation / compaction / undo / diverged before resuming ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §4) |
| `lastUsedAt` | timestamp | Drives the idle expiry |
| `fingerprintSource` | derived | Only when the key was fingerprinted, not header-supplied |

### What happens to the binding when the Account goes away

There is **no migration path**. A bound Session is never carried to another Account, because the
receiving Account cannot resume the id. The only available operation is to **invalidate the
binding and start a fresh upstream session**, and the router says so rather than pretending the
conversation continued.

| Account becomes | Binding | Next request on that Session |
|---|---|---|
| `cooling_down` | **Kept.** The clock will fix it, and the conversation is still resumable when it does | Served by another Account only if the caller cannot wait — and that means invalidating the binding and starting fresh, not resuming elsewhere. Preferring the honest `429` keeps the conversation intact |
| `exhausted` | **Invalidated.** No clock returns this Account | Rebinds to a new Account, new `sdkSessionId`, prior turns gone — surfaced, never silently truncated |
| `needs_reauth` | **Invalidated** | Same as above |
| `disabled` / removed from the pool | **Invalidated** | Same as above |
| Out of the key's scope | **Invalidated for that key** | Scope always wins; a binding can never reach an Account the key may not use |

Two rules hold in every row: the mapping is dropped rather than moved, and losing prior turns is
**reported**, not hidden behind a silently truncated context or a flattened replay presented as
real history.

On the plain HTTP path none of this applies — every request carries its full history, so an
unavailable Account costs a cold prompt cache and nothing else.

## UsageRecord

**One row per upstream *attempt*, not per client request.** Failover means a single client request
can emit several rows — three accounts tried, three rows — joined by a correlation id. Totals count
the client request once and the attempts separately, and the UI must say which is which or the
numbers look wrong. Rows are enqueued in memory and batch-written off the request path.

| Field | Type | Notes |
|---|---|---|
| `id` | id | One per upstream attempt |
| `correlationId` | id | Shared by every attempt belonging to one client request |
| `attempt` | number | 1-based position in the failover chain |
| `apiKeyId` | id | |
| `accountId` | id | Which account actually served it |
| `sessionKey` | string | |
| `model` | string | The model the client asked for |
| `tokensIn` / `tokensOut` | number | As reported by the upstream |
| `costEstimate` | number | From the static, user-overridable price table |
| `latencyMs` | number | |
| `outcome` | enum | Success, or the `RouterError` subclass that ended it |
| `createdAt` | timestamp | 90 days raw, then rolled up to daily aggregates |

## AuditEvent

Append-only record of admin-plane mutations. **Never contains credential material.**

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `kind` | enum | Account added, connected, reauthorized, re-checked; key created/revoked; policy changed; key value viewed |
| `subject` | ref | Entity id the event concerns |
| `detail` | json | Redacted by the tested redactor before write |
| `createdAt` | timestamp | 365 day retention |

## ScheduledTaskRun

One row per run of a periodic task. Background work is in-process and coordinated by a Postgres
advisory lock per task, so **this row is how anyone knows a sweep happened** — the admin UI reads it
to show "janitor last ran 4 min ago, deleted 812 rows", and a task that has stopped running shows as
a stale `startedAt` instead of failing silently. Contract and rationale:
[01-architecture.md](01-architecture.md#background-work-and-scheduling).

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `task` | enum | Which periodic task: janitor sweep, usage rollup, OAuth-state purge, quota floor refresh |
| `startedAt` | timestamp | Set when the advisory lock is acquired. A replica that fails the lock writes nothing |
| `finishedAt` | timestamp, optional | Null while running — and still null long after, on a run that was killed halfway |
| `outcome` | enum | `success` \| `failed` \| `partial` (batch limit reached, more work remains for the next run) |
| `itemsProcessed` | number | Rows deleted or aggregated, per the task's own unit. What the one-line summary log reports |
| `error` | string, optional | Message only, redacted. Never credential material |

## Account state machine

| Transition | Trigger | Effect on routing |
|---|---|---|
| `active` → `cooling_down` | Upstream `429` for a spent rate-limit window, or circuit breaker trips on repeated failures | Filtered out of candidates until the cooldown expires. The window refills on a clock |
| `cooling_down` → `active` | Reported reset time passes, else exponential backoff elapses; a half-open probe (or the operator's "Re-check now") confirms | Eligible again; no operator action needed |
| `active` → `exhausted` | Driver classifies the upstream signal as a drained prepaid balance, an expired plan, or failed billing — **not** a refilling window | Removed from every candidate set immediately and surfaced loudly in the UI, because it silently shrinks the pool. No reset timestamp exists and the router never retries it on a timer |
| `cooling_down` → `exhausted` | A retry after the cooldown returns an out-of-credits signal instead of success | Same as above |
| `exhausted` → `active` | **Human action only** — top up, fix billing, or replace the credential, then "Re-check now" confirms against the provider's live signal | Eligible again. No clock and no backoff can make this transition |
| `active` → `needs_reauth` | Background OAuth refresh fails | Excluded from routing rather than failing requests; surfaced in the admin UI |
| `needs_reauth` → `active` | Operator completes Reconnect (same OAuth flow, existing row) | Eligible again, keeping id, pool membership, and usage history |
| `active` → `disabled` | Operator disables it | Filtered out indefinitely; no automatic return |
| `disabled` → `active` | Operator re-enables it | Eligible again |

API-key accounts never enter `needs_reauth` — they have no refresh and are valid until revoked
upstream. Claude subscription accounts do not refresh through us either: the SDK's config directory
handles it, and `needs_reauth` there means the SDK reported a login that can no longer be renewed.
Reconnect re-runs the CLI login into the same directory, keeping the row.

`cooling_down` and `exhausted` are never conflated. A clock fixes the first; only a human fixes the
second.

**Every transition out of `active` also decides the fate of the Sessions bound to that Account** —
`cooling_down` keeps their bindings, every other exit invalidates them, and an invalidated binding
means a restarted conversation, not a relocated one. See the table under
[Session](#session).

## ApiKey lifecycle

| Stage | What is true |
|---|---|
| **created** | The operator names the key and binds it to Pools. The value is generated and stored encrypted |
| **active** | Verifies on the data plane. The value is viewable and copyable from the admin UI at any time, as often as needed — viewing is audited and does not rotate the key |
| **revoked** | Fails verification immediately. Historical `UsageRecord` rows stay joinable |
| **purged** | 30 days after revocation the row is deleted by the janitor |

## Session lifecycle

| Stage | What is true |
|---|---|
| **derived** | On the first request that has no live session |
| **bound** | SDK path only: an Account and an `sdkSessionId` exist and are persisted. The conversation can be resumed — on that Account and nowhere else |
| **live** | Holds the conversation on one account: per-account prompt caching keeps paying off, and on the SDK path the conversation stays resumable at all |
| **invalidated** | The bound Account became unusable (table above). The mapping is dropped; the next request starts a fresh upstream session on a new Account, and the loss of prior turns is surfaced |
| **idle** | 24 h since last use → swept by the janitor, together with its fingerprint entry. **DEFERRED** for the SDK-path binding specifically: upstream SDK sessions live for weeks, so a 24 h sweep may destroy a resumable conversation for no reason — the right bound for that table is an open question ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) §11) |

Session key derivation, in order:

1. **Client-supplied session header** — used verbatim when present.
2. **Fingerprint** — otherwise, derived from the first user message plus the working directory. Two
   invocations of the same agent in the same directory land on the same account; a different project
   gets its own session.

Both forms are **scoped by Account**: resuming against the wrong Account is both a guaranteed cache
miss and a leak of one subscription's conversation into another's.

What the key is *used for* differs by path, and the difference is the whole point:

| Path | Session → Account is | Consequence |
|---|---|---|
| Plain HTTP | **Recomputed** — the key is an input to rendezvous (highest-random-weight) hashing, stored nowhere | Survives restarts with no stored map; adding or removing an account only reshuffles that account's share of sessions |
| Agent SDK (`anthropic-oauth`) | **Stored and authoritative** — hashing places a *new* Session, and after that the persisted binding is read, not re-derived | A recomputed guess cannot resume an id another Account owns. This is the one mapping that must survive a restart as data, not as arithmetic |

## Persisted vs. in-memory

| Persisted (Postgres) | In-memory only (bounded LRU) |
|---|---|
| Account (incl. encrypted auth material) | Account health: cooldown expiry, in-flight count, recent failures |
| Pool and membership | The session/fingerprint **caches** — a fingerprint entry dies with its session. A cache in front of the row below, not the truth |
| **Session → Account binding + `sdkSessionId` + lineage state** (SDK path) — authoritative, because it cannot be recomputed and a lost binding costs a live conversation | Rendezvous placement for unbound sessions and for the plain HTTP path — pure arithmetic, nothing to store |
| ApiKey (incl. encrypted value) | Rate-limit and circuit-breaker counters — expire with their reset window |
| UsageRecord and daily rollups | Selection snapshots (constructed per request, injected into the pure selector) |
| AuditEvent | The pending write queue of `UsageRecord` rows, drained in batches by the background writer |
| Pending OAuth state + PKCE verifier (one-shot, 10 min TTL) | Per-account refresh timers and their single-flight guards — rebuilt at boot from `tokenExpiresAt` |
| ScheduledTaskRun — deliberately persisted, because an in-memory last-run record dies with the process that wedged | The advisory lock itself: a Postgres session-scoped lock, released on disconnect, never a row |
| Last known quota window state per Account | The hot copy of it that selection actually reads |

Per-Account `CLAUDE_CONFIG_DIR` contents are the third location: a persistent volume on disk, owned
by the SDK, holding live credential material — neither a database row nor a cache.

Caches are size-bounded with coordinated eviction, and the read path is served from them so nothing
in normal request handling waits on the database. Retention windows are configuration, not constants
in code.

Related: [00-overview.md](00-overview.md) · [01-architecture.md](01-architecture.md) ·
[03-providers.md](03-providers.md) · [05-routing-and-failover.md](05-routing-and-failover.md) ·
[06-protocol-translation.md](06-protocol-translation.md) · [07-security.md](07-security.md) ·
[11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)
