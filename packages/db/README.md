# @multi-ai-router/db

Drizzle schema, migrations, the Postgres connection factory, and the repositories that own every
query in the router.

## What it owns

| Owns | Does not own |
|---|---|
| The Drizzle schema — tables, enums, indexes, row types | Business logic. Selection, quota math, and cost estimation are pure functions elsewhere |
| Migrations: generation, and applying them at boot | HTTP. Nothing here knows about requests, headers, or status codes |
| The connection factory and pool settings | Routing decisions — this package never chooses an account — and encryption: ciphertext arrives and leaves as ciphertext |
| Repositories — the only place SQL is written | |

**Repositories own SQL; services never inline a query** (CLAUDE.md, Conventions). A service calls a
repository method; if it needs a new query, the method is added here. `src/repositories/` is the
only place `select`, `insert`, `update`, or `delete` may appear.

Nothing in this package belongs on the request-critical path. Key verification, account selection,
and health are served from warm in-memory caches; usage rows are enqueued and batch-written off-path.

## Layout

```
src/
  index.ts            explicit public API barrel
  client.ts           createDatabase() — postgres.js pool + Drizzle instance
  migrate.ts          runMigrations() + a runnable entry point
  schema/
    index.ts          re-exports every table
    enums.ts          pgEnums, built from @multi-ai-router/core's Zod .options
    <domain>.ts       one file per concern: accounts, quota-windows, pools,
                      api-keys, api-key-scope, sessions, usage-records,
                      usage-daily, audit-events, scheduled-task-runs, oauth-states
  repositories/       one module per aggregate; all SQL lives here
migrations/           generated SQL, committed, applied at boot
test/unit/            schema-shape assertions, no database
test/integration/     needs a live Postgres, skips cleanly without one
```

## Schema

| Table | Purpose |
|---|---|
| `accounts` | One credential to one provider. Many per provider is the normal case |
| `quota_windows` | One row per account per window: utilization, reset, and how trustworthy each is |
| `pools` | A named set of accounts with a routing policy |
| `pool_members` | Account ↔ pool membership, carrying that membership's weight and priority |
| `api_keys` | Router-issued `mar_live_…` keys — encrypted, retrievable, never hashed |
| `api_key_pools` / `api_key_accounts` | A key's scope targets |
| `sessions` | Conversation identity, and on the SDK path the authoritative account binding |
| `usage_records` | One row per upstream **attempt**, joined by `correlation_id` |
| `usage_daily` | Hourly rollup, idempotent per (day, key, account, model) |
| `audit_events` | Append-only admin-plane mutations. Never credential material |
| `scheduled_task_runs` | One row per periodic-task run — how anyone knows a sweep happened |
| `oauth_states` | One-shot OAuth `state` + PKCE verifier, short TTL |

Modeling decisions worth knowing:

| Decision | Why |
|---|---|
| Scope targets are join tables, not a JSONB array | Scope is enforced as an intersection on every request. A join keeps that a query, and a deleted pool cannot leave a dangling id behind |
| `usage_records.api_key_id` / `account_id` are nullable, `ON DELETE SET NULL` | A revoked key is purged 30 days later, and its historical rows must stay joinable until then and readable after. An attempt that failed before selection has no account at all |
| `usage_daily` carries **no** foreign keys | Raw rows expire on the retention window; the rollup does not. A lifetime total has to outlive the key that earned it |
| `cost_metered` and `cost_notional` are separate columns | A subscription is a flat fee, so its per-request cost is an attribution, not a charge. The docs forbid summing the two |
| `sessions.account_id` is `ON DELETE SET NULL` | A binding is *invalidated*, never migrated: another account cannot resume an SDK session id. The FK is the backstop; the service clears `sdk_session_id` and lineage with it |
| Closed sets are `pgEnum`; open labels are `text` typed against core | An unknown `account_status` is a bug worth a migration to change. A new quota window kind or `RouterError` code is a core-only change |

Enum values are built from `@multi-ai-router/core`'s Zod `.options`, so the Postgres type and the
validated domain type cannot drift.

## Migrations

| Step | Command / entry |
|---|---|
| Generate SQL after a schema change | `bun run db:generate` (drizzle-kit; needs `DATABASE_URL`) |
| Verify the generated set | `bun run db:check` |
| Apply | `runMigrations({ url })`, called at boot before the listener opens |
| Apply by hand | `bun run migrate` |

Generated SQL is committed. drizzle-kit never runs in the container.

`runMigrations()` pins one connection and takes a session-scoped `pg_advisory_lock`, so two
replicas starting against the same database converge instead of racing the same DDL. Re-running is a
no-op: already-applied files are skipped.

A failure **fails the boot, loudly** — the entry point writes one structured line naming the
migrations folder and the error, then exits non-zero. A router answering requests against a schema
it does not understand is worse than one that is down.

## Connecting

```ts
import { createDatabase } from "@multi-ai-router/db"

const { db, sql, close } = createDatabase({ url: env.DATABASE_URL, maxConnections: 10 })
```

A factory, not a singleton, and this module has **no side effects at import time**: a module-level
connection would dial a database on import — including in unit tests that never touch one — and
leave nobody responsible for draining it. The server, the migration runner, and each test own a
handle and close it. `sql` is exposed for advisory locks and the migrator; everything else goes
through `db` and a repository.

Failures here throw plain `Error`s rather than `RouterError`s: every subclass in core is a request
outcome with a fixed HTTP status, and a missing `DATABASE_URL` has no client to answer.

## Testing

`bun test packages/db` — the unit suites need no database.

| Suite | Asserts |
|---|---|
| `test/unit/enums.test.ts` | Shared enums equal core's `.options` in order; `account_status` is exactly the five documented states including `exhausted`; the six routing policies; open-vs-closed set split |
| `test/unit/schema-shape.test.ts` | Every table exposes exactly its documented columns; uuid PKs with database-side defaults; every timestamp carries a time zone; `sessions` has both `account_id` and `sdk_session_id`; `usage_records` has `correlation_id`, cache tokens, and router overhead |
| `test/unit/indexes.test.ts` | The indexes the access patterns need, by column: key display-prefix lookup, usage by key/day, session lookup, rollup grain |
| `test/integration/migrations.test.ts` | Migrations apply, are idempotent when run twice, and produce every expected table. Skips cleanly when `DATABASE_URL` is unset or no SQL has been generated |

## See also

- [`docs/idea/02-domain-model.md`](../../docs/idea/02-domain-model.md) — the entity field tables this
  schema implements
- [`docs/idea/09-deployment.md`](../../docs/idea/09-deployment.md) — boot-time migrations, retention
  windows, and the operator's environment
