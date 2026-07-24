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
  app.ts                      createApp() — pure factory, no listener, no side effects
  types.ts                    AppEnv: the Hono Variables contract (requestId, log)
  config/env.ts               Zod env schema, parseEnv(), EnvValidationError
  middleware/
    requestId.ts              Assigns/propagates the correlation id
    logger.ts                 Binds the request-scoped logger, one line per request
    errorHandler.ts           onError + notFound — the only place a throw becomes a response
  errors/render.ts            Pure: thrown value → status + dialect-appropriate JSON body
  logging/
    logger.ts                 Structured JSON lines, levels, child loggers
    redact.ts                 Deny-listed field names + secret-shaped values
  routes/health.ts            GET /healthz, GET /readyz
  services/health/
    readiness.ts              checkReadiness() over injected probes — no I/O, no Hono
    databaseProbe.ts          select 1 on the warm pool, bounded by a timeout
test/
  unit/                       Pure: env parsing, error rendering, redaction
  integration/                The real app via app.request(), probes injected
```

## Boot sequence

Ordered, and the order is the point — **this is the part not to break.**

| # | Step | Rule |
|---|---|---|
| 1 | `parseEnv(process.env)` | Pure function over a raw map. Invalid → `process.exit(1)` after writing every offending variable to stderr |
| 2 | `runMigrations()` from `packages/db` | **Before the listener opens.** Idempotent, advisory-locked, so two replicas starting together converge |
| 3 | `createDatabase()` | One pooled handle, owned by `main.ts` and closed on shutdown |
| 4 | `createApp({ logger, probes })` | Builds routes and middleware. No listener, no timers, no `process.env` |
| 5 | `Bun.serve({ port, fetch: app.fetch })` | `SIGTERM`/`SIGINT` stop the server, then drain the pool |

A bad environment or a failed migration **exits non-zero naming the cause** and never starts
degraded — a router answering on a half-migrated schema is worse than one that is down.

## Endpoints

| Endpoint | Auth | Status | Behavior |
|---|---|---|---|
| `GET /healthz` | none | shipped | **Liveness.** 200 whenever the process is serving. Never touches the database — zero healthy accounts is an operator problem, not a reason to restart a working process |
| `GET /readyz` | none | shipped | **Readiness.** 200 only when the database answered **and** at least one Account is healthy; otherwise 503 with `checks` and a short `reason` |
| `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/models` | router key | M3 | Data plane — not present yet |
| `/api/admin/**` | session cookie | M7 | Admin plane — not present yet |
| `GET /metrics` | deferred | M8 | Prometheus exposition |

The two health endpoints are deliberately **not** aliases: aliasing them is the classic mistake,
and it makes an orchestrator restart a healthy process because Postgres blinked. The account half
of `/readyz` is a marked `TODO(M2)` returning true; the database half is real today.

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

- **`ADMIN_PASSWORD_HASH` wins over `ADMIN_PASSWORD`** when both are set; **exactly one must be
  present or boot fails**, naming both variables.
- **`ENCRYPTION_KEY` is decoded, not merely present**: base64/base64url in, must yield exactly 32
  bytes. A 16-byte key fails the boot instead of producing a weak cipher later.
- An empty string means unset — `PORT=` takes the default rather than failing.

## Testing

`bun test apps/api`

| Tier | Scope |
|---|---|
| `test/unit/` | Pure. `parseEnv` (defaults, precedence, both-missing, key length, every named variable), the thrown-value → status/body mapping, and redaction. No I/O, no mocks |
| `test/integration/` | The **real** app through `app.request(...)`: health, readiness, 404 shapes, and a thrown `RouterError` becoming its documented status |

Readiness probes are injected into `createApp`, so **integration tests need no database**. The one
test that wants a live PostgreSQL skips cleanly when `DATABASE_URL` is unset. `rootDir` is `src`,
so `tsc --build` does not type-check `test/` — `bun test` is what exercises it.

## Gotchas

| Gotcha | What it means for you |
|---|---|
| The dialect shapes the body, never the status | `dialectForPath` picks the Anthropic shape for `/v1/messages` and the OpenAI shape everywhere else. The **status and code come from the `RouterError` instance** (`packages/core` owns that table) — never re-derive one from the route |
| The logger redacts by default | A new field carrying a secret must be added to the deny list in `logging/redact.ts`. Anything not deny-listed is logged verbatim apart from secret-shaped values (`mar_live_…`, `sk-…`, `Bearer …`) |
| A supplied request id is only reused if it is safe | `x-request-id` must match `^[A-Za-z0-9_.:-]{1,128}$`; anything else gets a fresh UUID, so a caller cannot inject into a header or a log line |
| An unknown throw is always a bare 500 | Only a `RouterError` message reaches the client. Everything else renders `Internal server error`, with the real detail on the log line |
| `createApp()` has no side effects | No listener, no timer, no `process.env`. If a change needs one, it belongs in `main.ts` — otherwise every test starts booting the world |

## See also

- [`../../docs/idea/01-architecture.md`](../../docs/idea/01-architecture.md) — request lifecycle, layering, dependency rules, the performance budget
- [`../../docs/idea/04-api-keys-and-access.md`](../../docs/idea/04-api-keys-and-access.md) — the two auth planes, key format, scope enforcement
- [`../../docs/idea/09-deployment.md`](../../docs/idea/09-deployment.md) — the full env reference, migrations at boot, troubleshooting
