# `@multi-ai-router/api`

The router itself: the Hono server every client and the admin SPA talk to.

## What it owns

| Owns | Does not belong here |
|---|---|
| The HTTP surface — routes, middleware, request id, error rendering, SSE relay | Business logic. A route calls one service; the service holds the rules |
| Both auth planes: admin session cookie + CSRF (`/api/admin/**`), router-key verification (`/v1/**`) | SQL. Repositories in [`packages/db`](../../packages/db) are the only place with queries |
| Zod validation of the environment and of every client request | Domain types and the `RouterError` hierarchy — those come from [`packages/core`](../../packages/core) |
| The boot sequence: validate, migrate, connect, serve | Anything that must run without an HTTP request. Scheduler tasks are services, not routes |

Two CLAUDE.md rules govern everything below. **Routes are thin** — parse → validate → call one
service → render, with zero business logic in a handler. **Transport is the only layer that
touches Hono** — no service, driver, or repository imports the framework or sees a `Context`, so
`src/services/**` takes plain values and returns plain values.

## Layout

```
src/
  main.ts                     The only module that boots. Nothing imports it
  composition.ts              createRuntime() — every long-lived object, built once, injected down
  app.ts                      createApp() — pure factory, no listener, no side effects
  types.ts                    AppEnv, AdminServices — the transport-layer contracts
  config/env.ts               Zod env schema, parseEnv(), EnvValidationError
  middleware/                 requestId, logger, errorHandler, adminAuth, routerKeyAuth
  errors/render.ts            Pure: thrown value → status + dialect-appropriate JSON body
  logging/                    Structured JSON lines; the tested redactor
  routes/
    health.ts                 GET /healthz, GET /readyz
    admin/                    auth, accounts, pools, keys, providers + the shared render()
    v1/                       the four data-plane ingress paths
  providers/                  One driver per upstream, behind one interface + a total registry
  services/
    admin-auth/               Session cookie, CSRF, argon2id, login throttle
    admin/                    AdminResult, body parsing, audit recorder, cache-coherence decorators
    accounts|pools|keys/      Admin CRUD. Plain services; they know nothing about caches
    catalog/                  The warm accounts/pools snapshot the request path reads
    dataplane/                Body scan, session, egress decision, attempt chain, relay
    routing/                  Filter → policy → failover. Pure, injected snapshots
    usage/                    In-memory queue + batching writer, off the request path
    crypto/                   AES-256-GCM envelope over ENCRYPTION_KEY
    health/                   checkReadiness() over injected probes — no I/O, no Hono
test/
  unit/                       Pure: env, rendering, redaction, routing, drivers, usage math
  integration/                The real app via app.request(); upstreams and stores stubbed
  support/memory-store.ts     Honest in-memory repositories, so tests need no DATABASE_URL
```

## Boot sequence

Ordered, and the order is the point — **this is the part not to break.**

| # | Step | Rule |
|---|---|---|
| 1 | `parseEnv(process.env)` | Pure function over a raw map. Invalid → `process.exit(1)` after writing every offending variable to stderr |
| 2 | `runMigrations()` from `packages/db` | **Before the listener opens.** Idempotent, advisory-locked, so two replicas starting together converge |
| 3 | `createDatabase()` | One pooled handle, owned by `main.ts` and closed on shutdown |
| 4 | `createRuntime({ env, database, logger })` | The composition root. Every repository, cache, service, and writer is constructed here — once — and injected downward |
| 5 | `await runtime.start()` | **Awaited.** Loads the routing catalog and starts the background writers, so the first request is served against real state rather than an empty one |
| 6 | `createApp({ logger, probes, admin, dataPlane })` | Builds routes and middleware. No listener, no timers, no `process.env` |
| 7 | `Bun.serve({ port, fetch: app.fetch })` | `SIGTERM`/`SIGINT` stop the server, **then** flush the usage queue, **then** drain the pool — the reverse of the way in, because the flush needs the connection |

A bad environment or a failed migration **exits non-zero naming the cause** and never starts
degraded — a router answering on a half-migrated schema is worse than one that is down.

`createApp` takes `admin` and `dataPlane` as **optional**, so a test (or a console-only deployment)
can boot one plane without the other. That is also what keeps `createApp` a pure factory: the
production wiring lives in `composition.ts`, and a `Database` becomes a service in exactly one file.

## Endpoints

| Endpoint | Auth | Status | Behavior |
|---|---|---|---|
| `GET /healthz` | none | shipped | **Liveness.** 200 whenever the process is serving. Never touches the database — zero healthy accounts is an operator problem, not a reason to restart a working process |
| `GET /readyz` | none | shipped | **Readiness.** 200 only when the database answered **and** at least one Account is healthy; otherwise 503 with `checks` and a short `reason` |
| `POST /api/admin/auth/login`, `/logout`, `GET /session` | cookie (login issues it) | shipped | Session + CSRF. Login is throttled per IP and per username |
| `/api/admin/accounts/**` | session cookie | shipped | CRUD, disable, delete, `POST /recheck` and `POST /:id/recheck`. The OAuth connect/reconnect flows are **not** built |
| `/api/admin/pools/**` | session cookie | shipped | CRUD, membership, policy, weights, priority, overflow account |
| `/api/admin/keys/**` | session cookie | shipped | List, create, `POST /:id/reveal`, edit, `POST /:id/revoke`, delete |
| `GET /api/admin/providers` | session cookie | shipped | The static registry, so the console never keeps a second copy of it |
| `POST /v1/messages`, `/v1/chat/completions`, `/v1/responses` | router key | shipped, **passthrough only** | Same-dialect relay. Cross-dialect and the Agent-SDK path are refused by name in `services/dataplane/egress/mode.ts`, before any upstream call |
| `GET /v1/models` | router key | shipped | Exactly the models reachable within the presenting key's scope, shaped by the credential style the client authenticated with |
| `/api/admin/usage/**`, `/api/admin/settings/**` | session cookie | not built | M7–M8 |
| `GET /metrics` | deferred | not built | Prometheus exposition |

The two health endpoints are deliberately **not** aliases: aliasing them is the classic mistake,
and it makes an orchestrator restart a healthy process because Postgres blinked. The database half
of `/readyz` is real; **the account half still returns `true` unconditionally** (`assumeHealthyAccounts`,
a marked `TODO`) even though Accounts now exist — so `/readyz` currently under-reports a router with
nothing routable.

### What the data plane refuses, and why by name

`egress/mode.ts` is the single seam. It takes the leftmost mode that applies and rejects the rest
explicitly, before an upstream call, rather than degrading into a lossy approximation:

| Rejection | Client sees | Reason |
|---|---|---|
| `cross-dialect` | `400` `translation_failed` | The request as sent has no faithful representation upstream. That is a fact about the request, so the caller is told |
| `agent-sdk` | `503` `no_healthy_account` | A Claude subscription is served by `query()`, not by any HTTP driver. The caller did nothing wrong and can change nothing, so a `400` would send them looking in the wrong place |
| `unimplemented` | `503` `no_healthy_account` | The provider is declared in the domain and has no driver yet |

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL 16+ connection string. The bundled compose file supplies it |
| `ADMIN_USERNAME` | yes | — | The single admin identity. No user table in v1 |
| `ADMIN_PASSWORD` | one of | — | Plaintext password, hashed with argon2id at boot |
| `ADMIN_PASSWORD_HASH` | one of | — | Pre-computed argon2id hash |
| `ENCRYPTION_KEY` | yes | — | AES-256-GCM key for upstream credentials and router keys |
| `PORT` | no | `8080` | Listen port |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `TRUST_PROXY` | no | `false` | Honor `X-Forwarded-*`. Only behind a proxy you control |
| `PUBLIC_URL` | no | — | Base URL for the OAuth redirect callback. Unset → paste-back capture only |
| `CLAUDE_CONFIG_ROOT` | no | `/data/claude` | Parent of one `CLAUDE_CONFIG_DIR` per Claude subscription Account |
| `ACCOUNT_RECHECK_COOLDOWN_SECONDS` | no | `60` | Floor between manual **Re-check now** probes |
| `RETENTION_SESSIONS_HOURS` | no | `24` | Idle session + fingerprint TTL |
| `RETENTION_USAGE_DAYS` | no | `90` | Raw `UsageRecord` retention before rollup |
| `RETENTION_AUDIT_DAYS` | no | `365` | `AuditEvent` retention |
| `RETENTION_REVOKED_KEYS_DAYS` | no | `30` | Revoked key survival before purge |
| `RETENTION_OAUTH_STATE_MINUTES` | no | `10` | One-shot OAuth `state` + PKCE verifier TTL |
| `JANITOR_INTERVAL_MINUTES` | no | `60` | Base sweep interval, jittered |
| `ADMIN_SESSION_IDLE_MINUTES` | no | `480` | Sliding idle window; also the cookie's `Max-Age` |
| `ADMIN_SESSION_ABSOLUTE_HOURS` | no | `24` | Hard cap on total session life. A purely sliding session is one a thief renews forever |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | no | `5` | Failed logins per throttle key before it locks |
| `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES` | no | `15` | Failures older than this stop counting |
| `ADMIN_LOGIN_LOCKOUT_MINUTES` | no | `15` | How long a tripped key stays locked |
| `CATALOG_REFRESH_SECONDS` | no | `30` | How long the warm catalog may lag a write by **another replica**. This replica's own writes refresh it immediately |
| `KEY_CACHE_MAX` | no | `4096` | Verified keys held in memory. Eviction costs one indexed lookup, not correctness |
| `KEY_CACHE_TTL_SECONDS` | no | `60` | Reuse window for a successful verification. Revocation invalidates immediately regardless |
| `KEY_CACHE_NEGATIVE_TTL_SECONDS` | no | `5` | Reuse window for a *failed* lookup. Short: it stops a bad-key flood becoming a query flood, and a fresh key must work quickly |
| `USAGE_QUEUE_MAX` | no | `10000` | Queued `UsageRecord`s before the oldest are shed. Reporting degrades; traffic does not |
| `USAGE_BATCH_SIZE` | no | `200` | Rows per insert |
| `USAGE_FLUSH_INTERVAL_MS` | no | `1000` | Drain cadence. Widening it widens the crash-loss window; it never affects latency |

The last two groups are the request path's own tunables. Their defaults **mirror the layer
constants they override**, so an unset variable and a variable set to its default behave
identically — there is no second source of truth to drift.

- **`ADMIN_PASSWORD_HASH` wins over `ADMIN_PASSWORD`** when both are set; **exactly one must be
  present or boot fails**, naming both variables.
- **`ENCRYPTION_KEY` is decoded, not merely present**: base64/base64url in, must yield exactly 32
  bytes. A 16-byte key fails the boot instead of producing a weak cipher later.
- An empty string means unset — `PORT=` takes the default rather than failing.

## Working on it

`bin/` is the interface — never write an ad-hoc invocation where a wrapper exists.

| Task | Command |
|---|---|
| Fresh clone → running stack | `bin/setup` |
| Each session | `bin/dev` |
| Before committing | `bin/check` (lint → typecheck → test, the CI job list in order) |
| One suite | `bun test apps/api` · one pattern: `bun test <pattern>` |
| Dev database | `bin/db psql` · `bin/db migrate` · `bin/db reset` |

## Testing

| Tier | Scope |
|---|---|
| `test/unit/` | Pure. `parseEnv`, error rendering, redaction, routing selection and policies, driver headers + failure classification, rate-limit parsing, key scope, usage queue and token math, admin services over the memory store. No I/O, no mocks |
| `test/integration/` | The **real** app through `app.request(...)`: health, readiness, 404 shapes, a thrown `RouterError` becoming its documented status, the admin API end to end, and the data plane against a stubbed `fetch` |

Readiness probes are injected into `createApp` and stores come from `test/support/memory-store.ts`,
so **integration tests need no database**. The one test that wants a live PostgreSQL skips cleanly
when `DATABASE_URL` is unset. `rootDir` is `src`, so `tsc --build` does not type-check `test/` —
`bun test` is what exercises it.

**No test hits a real provider, ever** — the upstream is an injected `fetch`, and the Agent SDK is
stubbed at the `query()` boundary when that path lands.

## Gotchas

| Gotcha | What it means for you |
|---|---|
| The dialect shapes the body, never the status | `dialectForPath` picks the Anthropic shape for `/v1/messages` and the OpenAI shape everywhere else. The **status and code come from the `RouterError` instance** (`packages/core` owns that table) — never re-derive one from the route |
| The logger redacts by default | A new field carrying a secret must be added to the deny list in `logging/redact.ts`. Anything not deny-listed is logged verbatim apart from secret-shaped values (`mar_live_…`, `sk-…`, `Bearer …`) |
| A supplied request id is only reused if it is safe | `x-request-id` must match `^[A-Za-z0-9_.:-]{1,128}$`; anything else gets a fresh UUID, so a caller cannot inject into a header or a log line |
| An unknown throw is always a bare 500 | Only a `RouterError` message reaches the client. Everything else renders `Internal server error`, with the real detail on the log line |
| `createApp()` has no side effects | No listener, no timer, no `process.env`. If a change needs one, it belongs in `composition.ts` or `main.ts` — otherwise every test starts booting the world |
| An admin write must reach the request path before the response is written | The CRUD services are plain and know nothing about caches. The decorators in `services/admin/coherence.ts` refresh the catalog or invalidate the key **on success only**, and are awaited. A new mutating method that skips them ships a console that returns `201` for an account the next request cannot route to |
| Admin failures are `AdminResult`, not `RouterError` | Every core error class is a *data-plane* outcome with a fixed status. "That pool id does not exist" is none of them. Return `invalid` / `notFound` / `conflict` and let `routes/admin/render.ts` put it on the wire |
| Revealing a key is a `POST` | It is the only endpoint that returns a live credential, so it takes the mutating-method path and the CSRF token. Never add a `GET` that returns one |

## See also

- [`../../docs/idea/01-architecture.md`](../../docs/idea/01-architecture.md) — request lifecycle, layering, dependency rules, the performance budget
- [`../../docs/idea/04-api-keys-and-access.md`](../../docs/idea/04-api-keys-and-access.md) — the two auth planes, key format, scope enforcement
- [`../../docs/idea/09-deployment.md`](../../docs/idea/09-deployment.md) — the full env reference, migrations at boot, troubleshooting
