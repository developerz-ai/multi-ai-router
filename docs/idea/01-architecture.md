# Architecture

Status: the layering, dependency rules, performance budget, warm catalog, composition root, and
scheduler are **implemented and enforced**. Step 8's cross-dialect half is implemented for every
crossing between `anthropic`, `openai-chat`, and `openai-responses`, and step 8b (Agent SDK) is
implemented and served end to end; an untranslatable request is still refused explicitly rather than
approximated. See [00-overview.md](00-overview.md) for the product boundary and
[02-domain-model.md](02-domain-model.md) for the entities named below.

## Request lifecycle

1. **Ingress.** Hono receives `POST /v1/messages`, `POST /v1/messages/count_tokens`,
   `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/embeddings`, or `GET /v1/models`.
   The path fixes both the dialect and the operation; neither is ever sniffed from a body. The request id is assigned here
   and propagated end to end.
2. **Key verification.** The router key arrives as `Authorization: Bearer mar_live_…` or
   `x-api-key: mar_live_…`. Verification is served from an in-memory cache; on a miss, a short
   display prefix indexes the row, so it costs one indexed lookup plus one decrypt and a
   constant-time comparison — never a table scan. A revoked or expired key raises `KeyRevokedError`.
3. **Request validation.** The presenting key's own rate-limit ceiling is checked first, before a
   byte of the body is read, because a refusal must cost less than the request it refuses — over it
   is `KeyRateLimitedError`. Then only what routing needs is read from the body — the model name and
   the session key — extracted incrementally, and the model name is carried unchanged. The body size
   cap (`MAX_REQUEST_BODY_BYTES`, 32 MiB by default) applies here and nothing is ever parsed to
   enforce it: a declared `Content-Length` over the ceiling is refused unread, and a body that lies
   about its length is refused as it streams, in both cases with `413` `request_too_large` and never
   the `400` that would send a caller hunting a malformed field. The **model name has its own
   ceiling** — 256 bytes, a constant rather than a knob, because how long a model id may be is a
   property of the providers and not of the deployment. It is the one client-supplied string the
   router *stores*, on every attempt row and on a rolled-up row that outlives it, so an unbounded
   one is a write any key holder can make into two tables forever. Over it is a `400` naming the
   ceiling; it is never truncated, because a shortened model name is a substituted model. A full
   Zod parse into the ingress
   dialect's shape happens only when cross-dialect translation turns out to be required; on the
   passthrough path the body stays opaque. See the performance budget below.
4. **Session resolution.** The sticky key is taken from the client-supplied session header, else
   fingerprinted from the conversation's opening bytes. On the plain HTTP path this is **pure
   derivation with nothing stored** — the key is an input to rendezvous hashing, so placement
   survives a restart as arithmetic rather than as state. Only the SDK path needs a persisted
   Session→Account binding, and it needs it because an SDK session id cannot be resumed elsewhere.
5. **Candidate filtering.** The candidate set is **always the intersection of the Pool's members and
   the key's scope** — `all`, a set of Pools, or an explicit account list. A key can never reach an
   Account outside its scope, whatever the policy would prefer, and the intersection never silently
   widens. From that set, keep Accounts that are `active` — not `cooling_down`, not `exhausted`, not
   `disabled`, not `needs_reauth` — and that support the requested model. An empty result raises
   `NoHealthyAccountError`, which names the actual cause (rate limited, out of credits, nothing in
   scope) rather than failing generically.
6. **Policy selection.** The Pool's policy (`sticky` by default) picks one candidate from the
   filtered set. Pure function over the session key and an injected snapshot of account health —
   no clock, no store, no network. Details in [05-routing-and-failover.md](05-routing-and-failover.md).
7. **Driver shape.** *The path diverges here, on the chosen Account's Provider.* An **HTTP driver**
   serves API-key and non-Anthropic OAuth accounts (Anthropic API, OpenAI API and Codex, OpenRouter,
   z.ai, Kimi, MiniMax, Gemini, any compatible endpoint) — steps 8–9 below. An **SDK driver** serves
   Claude Max/Pro subscription accounts — step 8b. Everything before this point is identical for
   both, and so are failover, stream relay, and accounting after it.
8. **Credential injection (HTTP path).** The driver decrypts the Account's auth material, applies the
   provider's required headers (`x-api-key` vs. `Authorization: Bearer` + `anthropic-beta` are
   different modes, not interchangeable), and applies the Account's model alias map if it defines
   one. Credentials exist only inside the driver's outbound request. Translation is decided here:
   ingress dialect vs. the provider's native dialect, same dialect being a byte-for-byte passthrough
   and cross-dialect an explicit conversion — see
   [06-protocol-translation.md](06-protocol-translation.md).
   **8b. SDK invocation (Claude subscription path).** No credential is decrypted, injected, or
   forged. The driver spawns a `@anthropic-ai/claude-agent-sdk` subprocess with that Account's
   **`CLAUDE_CONFIG_DIR`** in its environment, so N subscriptions coexist with no
   cross-contamination, and the config directory — not the router — owns and refreshes the
   credentials. The SDK's output is then re-synthesized into the ingress wire format, which is this
   path's equivalent of translation. Quota signals arrive as SDK `rate_limit_event` stream events
   and feed the same circuit breaker and `quota-aware` policy. Costs (a subprocess per request, the
   `claude` CLI in the image) and the full contract:
   [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md).
9. **Upstream call.** The HTTP driver issues the request in its native dialect; the SDK driver reads
   the subprocess stream. Both yield the same internal response shape.
10. **Failover.** On `429`, `5xx`, or a connection failure, retry the next candidate. Retries are
    bounded, and only for requests that have not yet streamed bytes to the client. The driver
    classifies the failure from the upstream signal: a spent rate-limit window marks the account
    `cooling_down` until its reported reset time (or an exponential backoff when none is reported); a
    drained prepaid balance or dead billing marks it `exhausted`, which no timer clears.
11. **Stream relay.** SSE is relayed to the client. Passthrough forwards byte for byte; cross-dialect
    translates the event stream as it flows. Once bytes are on the wire the request fails honestly —
    no silent retry.
12. **Usage record.** One `UsageRecord` per upstream **attempt** — so a client request that failed
    over twice writes three rows, joined by a correlation id: key, account, session, model, token
    counts, cost estimate, latency, outcome. Enqueued in memory and batch-written by a background
    writer, never on the response path.

```
 client
   │  POST /v1/messages | /v1/chat/completions | /v1/responses | /v1/embeddings
   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  transport   │──▶│     auth     │──▶│   session    │
│ hono, req id │   │key → decrypt │   │ header | fp  │
└──────────────┘   └──────────────┘   └──────┬───────┘
                                             │ sessionKey
                                             ▼
                          ┌──────────────────────────────────┐
                          │            routing               │
                          │  filter ─▶ policy ─▶ candidate[] │  pure
                          └──────────────┬───────────────────┘
                                         │ Account
                                         ▼
                          ┌──────────────────────────────────┐
                          │           driver shape           │
                          └──────┬────────────────────┬──────┘
                     HTTP driver │                    │ SDK driver (Claude subs)
       ┌────────────┐  ┌─────────▼──────┐   ┌─────────▼───────────┐
       │translation │─▶│    provider    │   │  claude-agent-sdk   │
       │ pass|cross │  │ decrypt+inject │   │ CLAUDE_CONFIG_DIR   │
       └────────────┘  └─────────┬──────┘   │ subprocess per acct │
                                 │          └─────────┬───────────┘
                        upstream API                  │ re-synthesized
                                 └─────────┬──────────┘
                                           │ SSE / body (never buffered)
             ┌─────────────────────────────┼──────────────┐
             ▼                             ▼              ▼
        stream relay ─▶ client        UsageRecord      failover:
                                   (queued, batched) 429/5xx → next
```

## Layers

| Layer | Owns | Module path |
|---|---|---|
| transport | HTTP routes, middleware, request id, body caps, SSE relay | `apps/api/src/routes/**`, `apps/api/src/middleware/**` |
| auth | Admin session cookie + CSRF; router key verification and its cache | `apps/api/src/services/admin-auth/**`, `apps/api/src/services/dataplane/auth/**` |
| admin | CRUD services for accounts, pools, keys, plus the shared result/parse/audit/coherence plumbing | `apps/api/src/services/{accounts,pools,keys,admin}/**` |
| catalog | The warm accounts/pools snapshot the request path reads, and its refresh triggers | `apps/api/src/services/catalog/**` |
| data plane | Body scanning, session resolution, egress decision, attempt chain, stream relay | `apps/api/src/services/dataplane/**` |
| routing | Candidate filter, the six policies, failover order, circuit-breaker math | `apps/api/src/services/routing/**` |
| providers (HTTP driver) | One driver per HTTP Provider: dialect, endpoints, headers, failure classification | `apps/api/src/providers/**` |
| providers (SDK driver) | Claude subscriptions only: `claude-agent-sdk` subprocess per request, per-Account `CLAUDE_CONFIG_DIR`, SDK-event → wire-format re-synthesis, `rate_limit_event` quota signals — [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | `apps/api/src/providers/claude-sdk/**` |
| translation | Ingress ⇄ egress dialect conversion, streaming and non-streaming | `apps/api/src/services/translate/**` |
| usage | Usage records, rollups, metrics exposition | `apps/api/src/services/usage/**` |
| cost | The shipped price table (one file per vendor), the operator's warm override book, and the pure pricing arithmetic | `apps/api/src/services/cost/**` |
| scheduler | Every periodic task: jittered in-process interval timers, Postgres advisory-lock leader election, retention sweeps, usage rollup, OAuth-state purge, last-run/outcome recording | `apps/api/src/scheduler/**` |
| db | Drizzle schema over **PostgreSQL 16+** (postgres.js), migrations, repositories — the only place with SQL | `packages/db/**` |
| config | Zod-validated env, retention knobs, shared types and errors | `packages/core/**`, `apps/api/src/config/**` |

Everything is wired together in `apps/api/src/composition.ts` — see
[The composition root](#the-composition-root).

## Repo layout

```
apps/
  api/            Hono server: routes, middleware, services  (the router)
  web/            SolidJS admin SPA
packages/
  db/             Drizzle schema + migrations + repositories
  core/           shared types, errors, zod schemas
docs/idea/        this design spec
bin/              setup, dev, check, test, lint, fmt, build, db  (thin shell wrappers)
.github/workflows/ ci.yml, release.yml
```

`bin/` is the interface: `bin/setup` on a fresh clone, `bin/dev` each session, `bin/check` before
committing. Never write an ad-hoc invocation where a wrapper exists.

## Dependency rules

1. **Dependencies flow downward only.** `transport → services → providers/db → core`. A lower layer
   never imports a higher one.
2. **Routing selection is pure and imports nothing with I/O.** No database, no HTTP client, no
   `Date.now()`, no filesystem. It takes a session key, a candidate list, and an injected snapshot of
   account health, and returns a choice. Clocks and stores are parameters.
3. **Providers never import routing.** A driver knows its own dialect and credential handling. It
   does not know why it was chosen, how many candidates there were, or what happens on failure.
   This holds for both driver shapes: **HTTP driver and SDK driver implement the same interface**
   and are interchangeable to every layer above them. Routing, translation, usage, and transport
   never branch on "is this the SDK path" — the driver owns that difference.
4. **Routing never imports providers.** It selects an Account by id and metadata. Provider identity
   is data to it, not a module dependency.
5. **Transport is the only layer that touches Hono.** No service, driver, or repository imports the
   web framework or sees a `Context`. Services take plain values and return plain values.
6. **Repositories are the only place with SQL.** Services never write queries inline; they call a
   repository method. Postgres is the database (16+, Drizzle over postgres.js); its dialect,
   connection pool, and JSONB columns stay behind the repository interface. Migrations run at boot,
   are idempotent, and **fail the boot loudly rather than serving traffic on a half-migrated
   schema**.
7. **No circular dependencies.** Between packages, between layers, or between modules within a
   layer. If two modules need each other, the shared piece belongs in `packages/core`.
8. **`packages/core` imports nothing from the apps.** It holds types, errors, and Zod schemas, and
   has no runtime dependency on the server.
9. **Upstream credentials cross exactly one boundary.** Decryption happens inside the provider
   driver, on the outbound request. No upstream credential value is returned upward, logged, or
   serialized. Router keys are encrypted with the same key but are deliberately retrievable — only
   the admin plane's key-read endpoint may decrypt one, and it is audited.
10. **Claude subscription credentials never enter the process at all.** They live in that Account's
    `CLAUDE_CONFIG_DIR` on disk, owned and refreshed by the SDK. The router passes the directory
    path in the subprocess environment and reads the stream back — it never extracts, decrypts,
    stores, or forwards a subscription token, and no code path may add one to an outbound HTTP
    request. See [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md).
11. **Every external boundary is Zod-parsed.** Client requests, env, and provider responses. Nothing
    untyped enters the system — with the passthrough exception in the performance budget below: an
    opaque body that is never interpreted is relayed, not parsed.

## Performance budget

The router is in the hot path of every request every developer and every agent makes, so overhead it
adds is overhead everyone pays all day. **Treat it as a hard budget, not a tuning exercise:**
**< 5 ms added p99** on the passthrough path (excluding upstream time) and **zero added
time-to-first-token** beyond the one extra network hop.

| Rule | Consequence for the design |
|---|---|
| Never buffer a stream | Upstream bytes are relayed as they arrive. No accumulate-then-forward, no re-chunking, no waiting for a complete SSE event before flushing |
| Don't parse what you don't need | On same-dialect passthrough the body is opaque — swap headers and stream it through. Extract only the model name and session key, incrementally. A full parse happens only when cross-dialect translation is actually required |
| Nothing touches Postgres on the critical path | Key verification, account selection, health, and quota state are served from in-memory caches kept warm by the scheduler and by upstream responses. A miss is one indexed query, never a scan |
| Usage accounting is off the request path | `UsageRecord` rows are enqueued in memory and batch-written by a background writer. A slow database degrades reporting, never traffic |
| Reuse connections | Keep-alive pools per upstream host, warmed at boot, so a request never pays TLS setup. Same for the Postgres pool |
| Routing math is pure and allocation-light | Rendezvous hashing over a small candidate array; no I/O and no locks on the read path |
| Measure it | `router_overhead_seconds` (time inside the router, excluding upstream) is a first-class metric, shown next to upstream latency. A regression is a bug |
| Reproduce it on demand | `bin/bench` drives the real router against an in-process stub upstream and reads both claims back off its own metrics — p50/p95/p99 overhead per egress path, and added time-to-first-token measured separately. Non-zero exit when either breaks. See [08-observability.md](08-observability.md#verifying-the-budget) |

**The Agent-SDK path is the labeled exception.** A subprocess per request is inherently heavier than
an HTTP hop; the budget does not apply to it uniformly and the docs say so rather than pretending
otherwise. Pooling or reusing SDK processes is `DEFERRED` — measure first.

### The warm routing catalog

"Nothing touches Postgres on the critical path" is a rule; the **catalog** is the mechanism that
makes it true. It holds the accounts, pools, and membership that routing reads on every request, in
memory, and exposes them **synchronously** — `accounts()` and `pools()` return arrays, not
promises, because a method that *could* be awaited is a method someone will eventually await on the
request path.

It refreshes three ways, and the three cover different failure modes:

| Trigger | Why it exists |
|---|---|
| **At boot**, awaited before the listener opens | Serving against an empty catalog is indistinguishable from a deployment with no accounts configured. The first request must see real state |
| **After an admin write**, awaited before the response is written | Makes the console **read-after-write consistent**. An operator who adds an account and immediately fires a request gets the account they just added. Affordable precisely because this is the admin plane, where no latency budget applies |
| **On a jittered timer** (`CATALOG_REFRESH_SECONDS`) | The only mechanism that copes with a **second replica**. There is no broker, so a write made by another process arrives no other way — which makes the interval a bound on staleness, not a cache nicety |

Three consequences worth stating, because each is a decision rather than an implementation detail:

- **A failed refresh keeps the previous snapshot.** Serving slightly stale routing beats serving
  none: the alternative is a total outage because one periodic query timed out.
- **Concurrent refreshes share one in-flight promise.** Two identical queries racing to install the
  same snapshot is waste, not safety.
- **Disabled accounts stay in the catalog.** Filtering is routing's job, and a catalog that hides
  them makes "why did nothing match" unanswerable.

The write-through decorators live in `services/admin/coherence.ts` and are **decorators, not
service dependencies**: cache coherence is not a CRUD service's reason to change, and a service
that knew about the catalog could no longer be tested without one.

### The composition root

Every long-lived object in the process is built in **one file** — `apps/api/src/composition.ts` —
and injected downward. It is not ceremony; it exists so the two things that must be true of this
system can be *seen* in one place rather than inferred from twenty:

1. **Nothing on the request path touches Postgres.** A repository handed to a data-plane object is
   always a background caller — the catalog loader, the usage flusher, the key-cache miss path.
   That is auditable at a glance here and nowhere else.
2. **The two credential planes never meet.** Admin services and the data plane are built from the
   same repositories but wired into disjoint routers behind disjoint guards.

`createApp` stays a pure factory a test calls with stubs; composition is the production wiring and
the only place a `Database` becomes a service. It also owns start and stop: the catalog is loaded
and the background writers are running *before* the listener opens, and on shutdown the queue is
flushed before the connection it needs is closed. The flush is reached by a **bounded drain**:
`/readyz` starts refusing, the listener closes, in-flight responses get `SHUTDOWN_DRAIN_MS` to
finish, and then the flush runs whether or not they did — an unbounded wait would hand the exit to
the orchestrator's `SIGKILL` and lose the queue along with the streams. The pool close that follows
is bounded too, by `DB_POOL_CLOSE_TIMEOUT_SECONDS`, so a wedged query cannot hold the exit open past
work the flush has already written
([09-deployment.md](09-deployment.md#shutdown--draining)).

The [scheduler](#background-work-and-scheduling) is built here too, and it is the one thing given
the raw `postgres.js` pool rather than a repository — an advisory lock lives on a *session*, so a
task needs a connection it can reserve. Composition binds that into a lock capability and hands
that to the runner, so no service ever holds a connection. Ordering follows from what the lock
implies: arming the timers is synchronous and is *not* awaited at boot, because the first sweep is
not a precondition for serving a request; on the way out the scheduler stops **first** and is
awaited, because a tick in flight is holding a pooled connection and shutdown closes the pool.

## Background work and scheduling

All background work runs **in-process, on jittered interval timers, coordinated through Postgres**.
There is no broker, no worker container, and no system cron.

### Architectural decision: no BullMQ, no Redis/Dragonfly

The house default for background jobs is BullMQ on Dragonfly/Redis. This project deliberately
does not use it. The reasoning is recorded here so it is not quietly reinstated later:

| Reason | Detail |
|---|---|
| The deploy story is the product's promise | BullMQ needs Redis/Dragonfly: a third container, a third failure mode, and a third thing to back up, in a product whose install is three env vars and `docker compose up`. See [09-deployment.md](09-deployment.md) |
| The work is not queue-shaped | Everything below is small, periodic, and idempotent. No fan-out, no user-submitted work, no retry-with-backoff across workers, no dead-letter handling. A queue would sit almost empty |
| Postgres is already the coordination point | It is already present, already transactional, already backed up. A broker would buy durability that a table and a lock give for free |

`DEFERRED`: BullMQ + Dragonfly. Revisit only if a genuinely queue-shaped workload appears —
per-request async work, user-triggered long jobs, or fan-out across many workers. Recorded as a
decision in [10-roadmap.md](10-roadmap.md).

### The design

| Rule | Meaning |
|---|---|
| **In-process interval timers, jittered** | Each periodic task is a plain timer inside the router process. Jitter keeps replicas from aligning and keeps sweeps off request spikes and off each other after a restart |
| **One Postgres advisory lock per task** | Before doing work, a task takes `pg_try_advisory_lock` named for that task. Exactly one replica runs a given sweep; the others fail the try and skip instantly and cheaply. That is leader election without a leader-election system |
| **Idempotent, resumable, bounded batches** | Every task must be safe to run twice and safe to kill halfway, and must process or delete in fixed-size batches rather than one giant transaction. The data plane must not feel a sweep |
| **Last run and outcome are recorded** | Each run writes a `ScheduledTaskRun` row — task, start, finish, outcome, items processed, error — so the admin UI can say "janitor last ran 4 min ago, deleted 812 rows". **A wedged task is visible rather than silent**, which is the whole point of persisting the record. See [02-domain-model.md](02-domain-model.md) |

### The periodic tasks

| Task | Cadence | Notes |
|---|---|---|
| Janitor / retention sweeps | every `JANITOR_INTERVAL_MINUTES`, jittered | Bounded batches; windows in [09-deployment.md](09-deployment.md) |
| Usage rollup (raw → daily aggregates) | hourly | Idempotent per (day, key, account, model) |
| Circuit-breaker half-open probes | when a cooling-down account's reset passes | Not a fixed interval — scheduled per account |
| Quota refresh for subscription accounts | opportunistic, plus a slow floor | Prefer signals already in hand: `rate_limit_event` events arrive on responses we are already making, so an actively used account needs no polling. The floor covers idle accounts; **Re-check now** is the same code path triggered by hand — see [05-routing-and-failover.md](05-routing-and-failover.md) |
| Expired OAuth state / PKCE verifier purge | every few minutes | One-shot values, 10-minute TTL |

### Credential refresh is not a cron job

This is the part that is easy to get wrong, so it is stated as a rule rather than left implied.

| Rule | Meaning |
|---|---|
| **Per-account and expiry-driven** | Each OAuth account schedules its **own** refresh at a fraction of its remaining token lifetime — well before expiry, never lazily on a `401` — and re-schedules each time a new token lands. A fixed poll across all accounts is both wasteful and too late for a short-lived token |
| **Single-flight per account** | Concurrent triggers for one account — its timer, a re-arm after a login, an operator — await the same in-flight promise. Never N parallel refreshes racing to write the same row. **The request path is not one of those triggers**: a request never waits on a refresh, because nothing lazy on a `401` exists and no blocking I/O belongs on that path |
| **A failed refresh does not fail requests** | The account moves to `needs_reauth`, drops out of routing, and surfaces in the admin UI. Retries back off and then stop, rather than hammering the provider |
| **Claude subscription accounts have no router-managed token lifecycle at all** | Their credentials live inside that Account's `CLAUDE_CONFIG_DIR` and are refreshed by the Agent SDK / `claude` CLI. **The router never schedules, mints, or writes those tokens.** Our only job is to notice an SDK-reported auth failure and mark the account `needs_reauth`. Any doc or code describing a refresh timer for a Claude subscription is wrong — see [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) |

## SOLID / SRP rules

| Principle | Concrete rule here |
|---|---|
| Single responsibility | Files ≤ 300 LOC, split by responsibility, not by size. One module, one reason to change: `services/<domain>/<verb>.ts` — `services/key/minter.ts`, `services/account/refresher.ts`. |
| Open / closed | Provider drivers sit behind one interface. Adding a provider is adding one file in `providers/`, touching nothing else. |
| Liskov substitution | Every driver honors the same contract — same error types, same streaming shape — so routing can substitute any candidate Account for any other without special-casing. |
| Interface segregation | Thin routes, fat services: a route does parse → validate → call one service → render, and depends only on that service's signature. Zero business logic in a handler. |
| Dependency inversion | Pure core: routing selection, protocol translation, and quota math are pure functions; clocks and stores are injected. Repositories are an interface, not a database. |
| Error discipline | Custom error classes, never generic. `RouterError` base → `NoHealthyAccountError`, `QuotaExhaustedError`, `UpstreamTimeoutError`, `KeyRevokedError`, `CredentialDecryptError`. Each maps to one stable HTTP code. |
| Restraint | No premature abstraction. The second real implementation earns the interface. |

## Extension points

**Adding a provider** — see [03-providers.md](03-providers.md) for the driver contract.

0. **Pick the shape.** An **HTTP driver** covers everything that speaks a wire protocol over HTTP
   (API keys, OpenRouter, z.ai, Kimi, MiniMax, Codex, any compatible endpoint) — that is the default
   and the rest of this recipe. The **SDK driver** shape exists for exactly one case today, Claude
   subscriptions, and is described in [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md); a new
   provider takes it only if its vendor ships a first-party programmatic client that must own
   authentication. Both shapes satisfy the same interface, so nothing above the driver changes.
1. Add one file under `apps/api/src/providers/drivers/` implementing the driver interface.
2. Register its id in the static provider registry.
3. Pin its constants (endpoints, client id, scopes, required headers) in that same file, each with a
   comment recording where the value came from and what breaks if the provider changes it.
4. Classify its failure signals: which status + error body means `cooling_down` (a window that
   refills) and which means `exhausted` (a balance that does not), and where its reset timestamp
   comes from — see [05-routing-and-failover.md](05-routing-and-failover.md).
5. Add the provider to the admin UI's account-add form options.
6. Add a driver test against a mocked upstream. Nothing else changes.

**Adding a load-balancing policy** — see [05-routing-and-failover.md](05-routing-and-failover.md).

1. Add one pure selection function under `apps/api/src/services/routing/policies/`.
2. Register it in the policy registry and extend the policy enum in `packages/core`.
3. Expose it in the Pool settings screen.
4. Add unit tests — no mocks required, the function is pure.

**Adding an ingress dialect** — see [06-protocol-translation.md](06-protocol-translation.md).

1. Add the route under `apps/api/src/routes/v1/` with its Zod request schema.
2. Add the dialect's row and column to the translation matrix in `services/translate/`.
3. Declare which same-dialect provider drivers get passthrough.
4. Document the lossy edges for each new cross-dialect pair.

## Testing tiers

| Tier | Scope | Rule | Runner |
|---|---|---|---|
| Unit | Routing selection, translation, quota math, redaction, fingerprinting | Pure, no I/O, no mocks, no clock | `bun test` |
| Integration | HTTP in, mocked upstream out | Real Hono + a real disposable Postgres, upstreams stubbed | `bun test` |
| Contract | Provider drivers against recorded upstream responses | One per driver, both shapes: HTTP drivers against recorded responses, the SDK driver against a recorded SDK event stream | `bun test` |
| Boot | Zod env validation, encryption key presence, migrations applied | Bad config or a failed migration must exit non-zero naming the cause | `bun test` |
