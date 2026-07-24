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
| Across shell scripts | `bin/` | `bin/ci` calls `bin/lint` + `bin/test` |

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

`apps/api` depends on both packages. **`apps/web` currently depends on neither** — it restates
`AccountStatus` and `ResetSource` as local literal unions in `lib/`, and the `ResetSource` values
already disagree with core's. Adding `@multi-ai-router/core` and deriving those from the Zod schemas
is the fix; do not add a third copy.

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
| `createApiKeyRepository(db)` → `ApiKeyRepository` | `packages/db/src/repositories/api-key-repository.ts` | Any `api_keys` query. The only repository so far |
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

## Things that must never be duplicated

| Never copy | Why |
|---|---|
| The error code → HTTP status table | It lives on the `RouterError` subclass. A second mapping drifts and answers 500 where the class says 402 |
| Enum value sets (`AccountStatus`, `ProviderId`, `RoutingPolicy`, `KeyScope`, `ResetSource`, …) | Core's Zod schema is the source; db builds `pgEnum`s from `.options`. `apps/web` restates two of them by hand and its `ResetSource` values (`provider` / `estimate`) already differ from core's (`provider-reported` / `estimated`) — exactly the drift this rule exists to stop |
| Routing selection math (filter → policy → failover), when it lands | Pure functions with injected snapshots. A second implementation in the UI or a driver picks a different account than the router did |
| The log redactor (`logging/redact.ts`) | A second, weaker scrubber is how a credential reaches a log line. One redactor, one test asserting nothing leaks |
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
