# Reusable code

What already exists to be reused, and where a new shared thing belongs. Read this before writing a
helper — most of the small things you are about to write are already here.

## Where shared code lives

| Scope | Home | Example |
|---|---|---|
| Across apps (`apps/api` + `apps/web`) | a `packages/*` package | `packages/core/src/errors.ts` |
| Persistence, for any consumer | `packages/db/src/**` | `packages/db/src/repositories/` |
| Within one app only | that app's `src/lib/` | `apps/web/src/lib/cx.ts` |
| Within one app, but a layer not a helper | that layer's directory | `apps/api/src/logging/`, `apps/api/src/middleware/` |
| Across shell scripts | `bin/` | `bin/check` runs lint, typecheck, then `bin/test` — the CI job list, in order |

Timing, from the org standard (`gold-standards-in-ai/docs/architecture/solid-srp.md` — "Reusable
helpers, not copy-paste" and "No premature abstraction"):

- **Extract on the second real use, not in anticipation.** One caller does not earn a package, an
  interface, or a generic. Concrete first.
- **But when the same logic does appear a second time, lift it — never copy it.** A second copy is
  where the two versions start to disagree, and the disagreement is a bug nobody notices.
- Don't over-abstract while lifting. Move the function; do not invent a framework around it.

## The packages

### `@multi-ai-router/core`

The pure leaf. Types, errors, Zod schemas, contract constants.

| Belongs | Does not |
|---|---|
| `RouterError` hierarchy, domain enums, key format, contract constants | HTTP (no Hono, no `Context`), SQL, any I/O — no clock, no `Date.now()`, no network |
| Anything both apps and `packages/db` must agree on | Provider drivers, routing selection, translation, usage math |

`zod` is the only runtime dependency.

### `@multi-ai-router/db`

The only module that knows SQL.

| Belongs | Does not |
|---|---|
| Drizzle schema, migrations, connection factory, repositories | Business logic, HTTP, routing decisions, encryption (ciphertext in, ciphertext out) |

### Dependency direction

`core` → `db` → apps. Concretely: **core imports nothing of ours; db imports core; apps import both;
nothing ever imports an app.** If two modules need each other, the shared piece belongs in `core`
(`docs/idea/01-architecture.md`, dependency rules 7–8).

`apps/api` depends on both packages. **`apps/web` depends on `core` only** — it imports
`AccountStatus` and `ResetSource` as types and maps them to presentation, and never restates the
literals. It must never depend on `db`: the API's answer is the answer, and a browser has no
business knowing a table.

## Inventory

### Errors — `packages/core/src/errors.ts`

| Thing | Where | Use it when |
|---|---|---|
| `RouterError` (abstract base) | `packages/core/src/errors.ts` | Adding a new failure class. Never throw a bare `Error` for a request outcome |
| `NoHealthyAccountError` (503), `QuotaExhaustedError` (429), `CreditsExhaustedError` (402), `ScopeViolationError` (403), `KeyRevokedError` (401), `UpstreamTimeoutError` (504), `CredentialDecryptError` (500), `TranslationError` (400) | same | The failure is one of these. Adding a class = the class + its code in `ROUTER_ERROR_CODES` + a row in the `errors.test.ts` table |
| `ROUTER_ERROR_CODES`, `RouterErrorCode` | same | Typing an outcome column or metric label — `UsageOutcome` in db already does |
| `isRouterError(value)` | same | Narrowing an unknown throw. Used by `errors/render.ts` and `middleware/errorHandler.ts` |
| `QuotaExhaustedInit` | same | Constructing a 429 with `retryAfterSeconds` / `resetsAt` |

**The HTTP status comes from the error instance.** `error.status` and `error.code` are fixed at class
declaration. Nothing may re-derive a status from a route, a code string, or a second mapping table.

### Domain types & enums — `packages/core/src/domain/`

| Export | Where | Use it when |
|---|---|---|
| `AccountStatus`, `QuotaWindowKind`, `UtilizationSource`, `ResetSource`, `QuotaWindowState` | `domain/account.ts` | Any account/quota state — validation, DB enum, presentation |
| `Dialect`, `EgressMode` | `domain/dialect.ts` | Ingress/egress protocol decisions |
| `KeyScope` | `domain/key.ts` | Key scope (`all` \| `pools` \| `accounts`) |
| `ProviderId`, `AuthKind` | `domain/provider.ts` | Naming a provider or its auth style |
| `RoutingPolicy`, `DEFAULT_ROUTING_POLICY` | `domain/routing.ts` | Pool policy validation or defaults |

Each is a Zod schema **and** its `z.infer` type under one name. These are the single source of truth:
`packages/db/src/schema/enums.ts` builds its `pgEnum`s from `.options`, and API validation calls
`.parse` / `.safeParse` on the same schema. Never restate the literals — derive from the schema.

### Key helpers — `packages/core/src/ids.ts`

| Thing | Where | Use it when |
|---|---|---|
| `generateRouterKey()` | `packages/core/src/ids.ts` | Minting a key. The only source of key values |
| `isRouterKey(value)` | same | Shape check before touching the DB. Says nothing about existence or revocation |
| `routerKeyDisplayPrefix(value)` | same | Deriving the indexed clear prefix. Returns `null` on a malformed key, never a partial slice |
| `ROUTER_KEY_PREFIX`, `ROUTER_KEY_PATTERN`, `ROUTER_KEY_LENGTH`, `ROUTER_KEY_RANDOM_LENGTH`, `ROUTER_KEY_DISPLAY_RANDOM_LENGTH`, `ROUTER_KEY_DISPLAY_PREFIX_LENGTH` | same | Anywhere key shape matters — `logging/redact.ts` builds its scrubbing pattern from `ROUTER_KEY_PREFIX` |

### DB — `packages/db/src/`

| Thing | Where | Use it when |
|---|---|---|
| `createDatabase(options)` → `{ db, sql, close }` | `packages/db/src/client.ts` | Opening a pool. A factory, not a singleton — no side effects at import; the owner closes it |
| `Database`, `DatabaseHandle`, `SqlConnection`, `DatabaseOptions` | same | Typing anything that takes a handle. `databaseProbe.ts` takes `Pick<DatabaseHandle, "sql">` |
| `runMigrations({ url })`, `defaultMigrationsFolder()` | `packages/db/src/migrate.ts` | Boot, tests, `bun run migrate`. Advisory-locked and idempotent |
| `createAccountRepository(db)` → `AccountRepository` | `repositories/account-repository.ts` | Any `accounts` query — CRUD, and the `list` the catalog loads from |
| `createApiKeyRepository(db)` → `ApiKeyRepository` | `repositories/api-key-repository.ts` | Any `api_keys` query, including the scope join tables and the prefix lookup verification uses |
| `createPoolRepository(db)` → `PoolRepository` | `repositories/pool-repository.ts` | Pools and membership. `listMembersForPools` returns every pool's members in one statement — use it rather than a query per pool |
| `createAuditRepository(db)` → `AuditRepository` | `repositories/audit-repository.ts` | Appending an `AuditEvent`. Append-only; no update, and the one delete narrows by age and nothing else |
| `createUsageRecordRepository(db)` → `UsageRecordRepository` | `repositories/usage-repository.ts` | Usage persistence. `insertMany` is the whole mutation surface besides the retention sweep — a per-record insert is the round trip the batching exists to avoid |
| `createUsageReadRepository(db)` → `UsageReadRepository` | `repositories/usage-read-repository.ts` | Aggregates over raw `usage_records` — totals, breakdowns, buckets, percentiles. Requests are `count(distinct correlation_id)`, attempts are `count(*)`; never sum rows for "requests" |
| `createUsageDailyRepository(db)` → `UsageDailyRepository` | `repositories/usage-daily-repository.ts` | The daily rollup, both directions: `rollup(from, to)` writes whole UTC days, `totals`/`breakdown` read them. Any aggregate over a **closed** day belongs here — raw rows expire, these do not |
| `toUtcDay`, `startOfUtcDay`, `startOfNextUtcDay` | same | Anything reasoning in the rollup's day grain. Do not re-derive the boundary arithmetic |
| `createScheduledTaskRepository(db)` → `ScheduledTaskRepository` | `repositories/scheduled-task-repository.ts` | The scheduler's run log. `begin`/`finish` bracket a tick; `lastRun` is the health read, `lastSuccess` is the cursor a catch-up task resumes from — a task reading `lastRun` inside its own `run` reads itself |
| `createSessionRepository(db)` → `SessionRepository` | `repositories/session-repository.ts` | Admin session rows, and the idle sweep behind them |
| `createOauthStateRepository(db)` → `OauthStateRepository` | `repositories/oauth-state-repository.ts` | One-shot `state` + PKCE verifier rows. `consume` is what turns a replayed `state` into a rejection; the purge deletes strictly after `expires_at` |
| `deleteOldestBatch({ db, table, id, agedBy, cutoff, limit, narrowedBy? })` → `number` | `repositories/bounded-delete.ts` | Any retention sweep, inside `packages/db` only. Postgres takes no `LIMIT` on a `DELETE`, so the batch comes from an ordered, limited subselect; the returned count is the caller's `partial` signal. Never hand-roll a second one |
| Tables, row types, `pgEnum`s, `schema` namespace | `packages/db/src/schema/**`, re-exported from `src/index.ts` | Building a query inside a repository |

**Repositories own SQL; services never inline a query.** A new query is a new method in
`src/repositories/`, not a `db.select()` in a service.

### API middleware & helpers — `apps/api/src/`

| Thing | Where | Use it when |
|---|---|---|
| `requestId()`, `REQUEST_ID_HEADER` | `middleware/requestId.ts` | Already mounted in `createApp`. Read the id via `c.get("requestId")` |
| `requestLogger(logger)` | `middleware/logger.ts` | Already mounted. Read the request-scoped logger via `c.get("log")` — never build a second one |
| `errorHandler(logger)`, `notFoundHandler()` | `middleware/errorHandler.ts` | The only place a throw becomes a response |
| `createLogger({ level, write?, now? })`, `Logger`, `LogFields` | `logging/logger.ts` | Any logging. `child(fields)` for scoped context. No `console.log`, ever |
| `redact(fields)`, `redactValue(s)`, `isSecretFieldName(name)`, `REDACTED` | `logging/redact.ts` | Anywhere a value could carry credential material. The logger already applies it |
| `toErrorResponse(error, dialect)`, `notFoundResponse(dialect)`, `renderErrorBody(...)`, `dialectForPath(path)` | `errors/render.ts` | Rendering a failure. Pure — no Hono, no I/O. The dialect shapes the **body**, never the status |
| `parseEnv(raw)`, `Env`, `EnvValidationError`, `decodeEncryptionKey(value)`, `LOG_LEVELS` | `config/env.ts` | Reading configuration. Pure over a raw map; `main.ts` owns the one `process.env` read |
| `AppEnv` | `types.ts` | Typing a Hono route or middleware. Transport-only — it never leaves that layer |
| `createApp(deps)` | `app.ts` | Integration tests. Pure factory: no listener, no timers, no `process.env` |
| `checkReadiness(probes)`, `ReadinessProbes`, `createDatabaseProbe(...)`, `assumeHealthyAccounts` | `services/health/` | Health surfaces. Probes are injected, so the service needs no I/O |
| `createRuntime(deps)` → `Runtime` | `composition.ts` | The composition root. Every long-lived object is built here once and injected downward — never construct a repository, cache, or recorder anywhere else |

### Metrics — `apps/api/src/observability/`

| Thing | Where | Use it when |
|---|---|---|
| `createRegistry(options)` → `Registry` with `counter` / `gauge` / `histogram` / `onCollect` / `expose` | `observability/registry.ts` | Any new metric primitive. Label names are declared once per metric and checked by the compiler, so a `request_id` label is a type error rather than a review comment. Series are capped per metric — cardinality may degrade, it may not take the process down |
| `createSeries(options)` → `RouterSeries` | `observability/series.ts` | Adding or renaming a series. **Every** exported metric is declared here and nowhere else; the mapping code never names a metric |
| `createMetrics(options)` → `RouterMetrics` | `observability/metrics.ts` | Turning a `UsageRecord`, a finished request, or a scheduler tick into numbers. Never measures anything itself |
| `createRuntimeMetrics(deps)` → `RouterMetrics` | `observability/runtime.ts` | The production wiring: the registry plus the per-scrape gauges read from the warm catalog and health store. `composition.ts` is its one caller |

Recording is off the critical path by construction: attempt series ride the usage recorder's
`onRecord` drain, state gauges are sampled per scrape, and the only per-request call is a single
counter increment at the point a request ends. Never add a metric write inside `attempt.ts` or the
failover chain.

### Cost estimation — `apps/api/src/services/cost/`

| Thing | Where | Use it when |
|---|---|---|
| `estimateCost(provider, upstreamModel, tokens)` → `CostEstimate` | `services/cost/estimate.ts` | Pricing an attempt. Pure — no clock, no store — and the **only** place a `costBasis` is decided: `metered`, `notional` for a subscription's attribution, `unknown` when unpriced. Unknown is null, never zero |
| `lookupRates(provider, model)` → `ModelRates \| null` | `services/cost/prices.ts` | Reading a shipped per-Mtok rate. One table, every entry commented with its provenance; a provider absent from it has no published per-model price |

### Admin-plane plumbing — `apps/api/src/services/admin/` + `routes/admin/render.ts`

Every admin route group is three lines because these four exist. Use them; do not hand-roll a
rejection shape, a body read, or an audit write.

| Thing | Where | Use it when |
|---|---|---|
| `AdminResult<T>`, `ok`, `invalid`, `notFound`, `conflict`, `failureBody` | `services/admin/result.ts` | Reporting an admin CRUD outcome. **Not** a `RouterError` — those are data-plane request outcomes with fixed statuses, and borrowing one points the console at the wrong layer. Only `400` / `404` / `409` exist here; nothing on this plane is a 5xx |
| `readJsonBody(request)`, `validate(schema, input)`, `validateId(value)` | `services/admin/parse.ts` | The two things every admin route does before calling a service. Hono-free — they take a `Request` and an `unknown` |
| `createAuditRecorder(sink)`, `AUDIT_KINDS`, `AUDIT_SUBJECTS`, `AuditSink` | `services/admin/audit.ts` | Any admin mutation. Every detail object passes through the tested redactor **inside** the recorder, so the "audit events never contain credential material" guarantee is structural rather than trusted at each call site |
| `withCatalogRefresh`, `withPoolCatalogRefresh`, `withKeyInvalidation`, `CoherenceHooks` | `services/admin/coherence.ts` | Making a write take effect on the request path before the response is written. **Decorators, not service dependencies** — cache coherence is not a CRUD service's reason to change, and a service that knew about the catalog could not be tested without one |
| `render(c, result, status?)` | `routes/admin/render.ts` | The one place an `AdminResult` becomes a response. Four copies of it is four chances for one to answer `200` with an error body |

### Warm routing catalog — `apps/api/src/services/catalog/`

| Thing | Where | Use it when |
|---|---|---|
| `createRoutingCatalog(deps)` → `RoutingCatalogStore` | `services/catalog/store.ts` | Reading accounts and pools on the request path. `accounts()` and `pools()` are **synchronous by design** — an `await` here would put Postgres on the critical path |
| `loadCatalog(sources)` → `CatalogData` | `services/catalog/load.ts` | Shaping rows into what routing consumes. Two queries total, never one per pool. Runs at boot, on the timer, and after an admin write — never on a request |

Disabled accounts are deliberately *in* the catalog: filtering is routing's job, and a catalog that
hides them makes "why did nothing match" unanswerable.

### Test support — `apps/api/test/`

| Thing | Where | Use it when |
|---|---|---|
| `createMemoryStore()` → `MemoryStore` | `test/support/memory-store.ts` | Any test of an admin service or the admin API. Not a mock with expectations — the smallest honest implementation of the four repository interfaces, so the service under test runs its real code path and the test asserts on **rows**. It is what lets the admin unit *and* integration suites run with no `DATABASE_URL` |

### Web — `apps/web/src/`

| Thing | Where | Use it when |
|---|---|---|
| `cx(...parts)` | `lib/cx.ts` | Every `class` built from CSS-module lookups. Template concatenation emits literal `"undefined"` |
| `statusPresentation`, `statusToken`, `statusLabel`, `isRoutable`, `needsOperator`, `hasReset`, `ACCOUNT_STATUSES` | `lib/account-status.ts` | Rendering an account status. One mapping table, no per-screen colour choices |
| `describeReset(input, nowMs)`, `formatDuration(ms)`, `formatAbsolute(epochMs)` | `lib/reset-countdown.ts` | Any reset/countdown display. Clock is a parameter — never read inside |
| `parseTheme`, `nextTheme`, `themeLabel`, `THEME_PREFERENCES`, `THEME_STORAGE_KEY` | `lib/theme.ts` | Theme logic (pure half) |
| `applyTheme`, `loadTheme`, `storeTheme` | `lib/theme-dom.ts` | Theme DOM/storage half, kept apart so the rules stay testable without a browser |
| `Table<T>`, `Column<T>` | `components/Table.tsx` | Every list surface. Structure, alignment, empty state — no sorting or fetching until a second caller needs it |
| `StatusDot` | `components/StatusDot.tsx` | Status atom in rows and headers. Colour never carries meaning alone |
| `PageHeader` | `components/PageHeader.tsx` | Title, subtitle, page-level actions |
| `Placeholder` | `components/Placeholder.tsx` | A screen that is scaffold, so nothing looks implemented when it is not |
| `ThemeToggle` | `components/ThemeToggle.tsx` | The header toggle. The one sanctioned `createEffect` in the app |
| `queryClient` | `lib/query.ts` | Server state. Configured in exactly one place — never construct a second client |
| `CONSOLE_ROUTES`, `LOGIN_PATH`, `AppShell`, `LoginScreen`, `NotFoundScreen`, `ConsoleRoute` | `lib/routes.ts` | Adding a screen. Single source of truth for the router **and** the sidebar |
| `createFocusTrap(options)` | `lib/focus-trap.ts` | Containing focus in a modal overlay. Deliberately small — the drawer's needs, not a dialog library; it grows an option when a second overlay needs one |
| `createScrollLock(active)` | `lib/scroll-lock.ts` | Holding the page still behind an open overlay. Scoped strictly to `active()`, previous value restored on cleanup — a permanently unscrollable page is the failure this shape rules out |
| `createMediaQuery(query)`, `SIDEBAR_QUERY` | `lib/media.ts` | Needing a breakpoint in JS. `SIDEBAR_QUERY` mirrors `styles/_breakpoints.scss`; CSS owns the layout, JS needs the same number for `inert` and the focus trap — change one, change the other |

## Things that must never be duplicated

| Never copy | Why |
|---|---|
| The error code → HTTP status table | It lives on the `RouterError` subclass. A second mapping drifts and answers 500 where the class says 402 |
| Enum value sets (`AccountStatus`, `ProviderId`, `RoutingPolicy`, `KeyScope`, `ResetSource`, …) | Core's Zod schema is the source; db builds `pgEnum`s from `.options`, and `apps/web` imports the types rather than restating them. A hand-written literal union is how the two versions start to disagree |
| Routing selection math (filter → policy → failover) | Pure functions in `apps/api/src/services/routing/` with injected snapshots. A second implementation in the UI or a driver picks a different account than the router did |
| The `AdminResult` failure shape | `services/admin/result.ts`. A route that builds its own `c.json({ error })` is a route that will answer `200` with an error body |
| The log redactor (`logging/redact.ts`) | A second, weaker scrubber is how a credential reaches a log line. One redactor, one test asserting nothing leaks |
| Per-token prices and the cost arithmetic | `services/cost/`. A total recomputed in the console or the rollup drifts from the `costEstimate` on the row, and the two numbers then disagree about what the same request cost |
| The `cooling_down` vs `exhausted` distinction | Clock-recoverable vs human-recoverable: 429 + `Retry-After` vs 402, countdown vs "needs top-up". Collapsing them makes the router retry a dead account on a timer forever |

## Conventions for new shared code

- **Helpers stay SRP** — small, one job, well-named, unit-tested. `bun test` covers `packages/core`,
  `apps/api/test/unit/`, and `apps/web/test/unit/` with no mocks and no I/O.
- **No `utils` grab-bag.** Split by concern — `lib/date.ts`, `lib/money.ts` — never one `utils.ts`
  accumulating fifty unrelated functions. The existing `apps/web/src/lib/` files are the pattern.
- **Every package exports an explicit public API from its barrel** (`src/index.ts`). Anything not
  exported is internal, and callers import `@multi-ai-router/core`, never a path inside `src/`.
- **Prefer pure functions with injected clocks, stores, and probes** — `describeReset(input, nowMs)`,
  `parseEnv(raw)`, `checkReadiness(probes)`, `createLogger({ write, now })` — so they test without
  mocks. Concrete first: the **second** real implementation earns the interface.

## See also

- [`packages/core/README.md`](../packages/core/README.md) — the full public API of the leaf package
- [`packages/db/README.md`](../packages/db/README.md) — schema, migrations, repository rules
- [`apps/api/README.md`](../apps/api/README.md) — boot sequence, endpoints, transport gotchas
- [`apps/web/README.md`](../apps/web/README.md) — design tokens, Solid idioms, component rules
- [`docs/idea/01-architecture.md`](idea/01-architecture.md) — repo layout, layering, dependency rules
