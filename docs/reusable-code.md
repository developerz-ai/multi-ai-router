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
| `RetryableRouterError` (abstract) | same | The failure can say *when* to come back. `errors/render.ts` reads `Retry-After` off this base, so a new clock-recoverable class gets the header for free |
| `NoHealthyAccountError` (503), `QuotaExhaustedError` (429), `KeyRateLimitedError` (429), `CreditsExhaustedError` (402), `ScopeViolationError` (403), `KeyRevokedError` (401), `UpstreamTimeoutError` (504), `CredentialDecryptError` (500), `TranslationError` (400) | same | The failure is one of these. Adding a class = the class + its code in `ROUTER_ERROR_CODES` + a row in the `errors.test.ts` table |
| `ROUTER_ERROR_CODES`, `RouterErrorCode` | same | Typing an outcome column or metric label — `UsageOutcome` in db already does |
| `isRouterError(value)` | same | Narrowing an unknown throw. Used by `errors/render.ts` and `middleware/errorHandler.ts` |
| `QuotaExhaustedInit`, `RetryableInit` | same | Constructing a 429 with `retryAfterSeconds` / `resetsAt` |

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
| `checkReadiness(probes)`, `ReadinessProbes`, `createDatabaseProbe(...)`, `createClaudeCliProbe(...)`, `assumeHealthyAccounts` | `services/health/` | Health surfaces. Probes are injected, so the service needs no I/O |
| `resolveClaudeCli(probe)`, `createCliProbe(options)`, `CliResolution`, `CliSource` | `providers/claude-sdk/` | Anywhere the `claude` binary's path is needed — the SDK driver's `pathToClaudeCodeExecutable`, `/readyz`, the image build. The ladder is pure over an injected probe; `cli-probe.ts` is the only part that touches the filesystem |
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

### Per-key limits & usage plumbing — `apps/api/src/services/`

| Thing | Where | Use it when |
|---|---|---|
| `createRateLimiter(options)` → `RateLimiter` | `services/dataplane/limits.ts` | Charging a request against a key's ceiling. Pure over an injected `nowMs` and its own map: no clock, no timer, no I/O. `check` charges *and* decides in one call — two calls would hand the same headroom to two concurrent requests |
| `createUsageRecorderFromEnv(deps)` → `UsageRecorder` | `services/usage/fromEnv.ts` | Building the production recorder: repository writer, queue shape from env, and the throttled log lines that keep a shed record or a rejected batch from being silent. `composition.ts` is its one caller; tests use `createUsageRecorder` with an array |

A per-key refusal is **not** a `QuotaExhaustedError`. Same status, different owner: one key spent its
own allowance, the pool did not run out. `key_rate_limited` and `quota_exhausted` stay apart in the
error hierarchy, in `UsageOutcome`, and on `router_requests_total`.

### Cross-dialect translation — `apps/api/src/services/translate/`

| Thing | Where | Use it when |
|---|---|---|
| `translationPair(ingress, egress)` → `TranslationPair \| null` | `services/translate/registry.ts` | Asking whether a dialect pair can be served, and getting the three converters that serve it. Null is the honest answer for the diagonal (that is a byte relay, not a translation) and for a pair with no entry. Adding a pair touches this file and nothing else |
| `createSseParser()` → `SseParser` | `services/translate/sse/parse.ts` | Reading SSE. The repo's **only** parser: frames come back the instant their blank line lands, carrying partial lines and split CRLFs across chunk boundaries. Never used on the passthrough path, which parses nothing at all |
| `relayTranslatedResponse(input)` | `services/dataplane/relay-translate.ts` | Writing a converted response. A sibling of `relay.ts`, never a mode inside it, so no edit here can put a parser on the passthrough path. Same `RelayObserver` contract, so token counting and TTFB are unchanged |

`request` and `response` on a pair run in **opposite directions** — a body converted toward the
account, an answer converted back toward the client. The `created` stamp and the fallback id are
injected, never read off a clock inside a translator, so a recorded input converts to the same bytes
in a test as on the wire.

### Transports — `apps/api/src/providers/` + `services/dataplane/`

| Thing | Where | Use it when |
|---|---|---|
| `PROVIDER_REGISTRY[id]` → `ProviderSupport` | `providers/registry.ts` | Deciding **how** a provider is reached. Narrow on `transport` — `http`, `agent-sdk`, `unimplemented` — never compare a `ProviderId` to decide a transport. Total over `ProviderId`, so a new id fails the file to compile |
| `httpDriver(id)` → `ProviderDriver \| null` | `providers/registry.ts` | Reaching for an HTTP driver's pure resolvers. Null means "not served over HTTP", which is an answer, not an error |
| `openAiOAuthAuthorizeUrl`, `openAiOAuthCodeExchange`, `openAiOAuthRefresh`, `readOpenAiOAuthTokens`, `chatGptAccountId` | `providers/drivers/openai-oauth.ts` | Anything touching the ChatGPT/Codex OAuth flow. Pure builders and one Zod reader: the file owns the endpoints, the client id, the scopes, and the fact that the **code exchange is form-encoded while the refresh is a JSON body**. Never hand-roll either request — and never configure the account id, derive it, on every refresh |
| `claudeSdkDriver`, `ClaudeSdkDriver`, `SdkAccount` | `providers/claude-sdk/driver.ts` | The Claude subscription facts: the one dialect it renders, its auth style, its alias map, and `resolveConfigDir` — the counterpart of `resolveBaseUrl`, which throws rather than falling back to a shared directory. A **separate** interface from `ProviderDriver` on purpose; three of that interface's members have no meaning here |
| `SdkInvoker`, `SdkInvocation`, `SdkSessionReport` | `providers/claude-sdk/invoke.ts` | The SDK path's `FetchLike`. In: Anthropic Messages bytes plus a resolved `SessionPlan`. Out: a `Response` of Anthropic Messages, and the SDK's own session id through `onSession`. Injected, so no test spawns a `claude` CLI |
| `createQueryLaunch(input)` → `QueryLaunch`, `MAX_TURNS` | `providers/claude-sdk/options.ts` | Launching one `query()`. Returns the `Options` plus `abort()`/`detach()`, because the SDK wants an `AbortController` while the data plane produces an `AbortSignal` — and a bridge listener on a signal that outlives the query is a leak. Every isolation field (`settingSources: []`, `strictMcpConfig`, `skills: []`, `tools: []`) reads as dead code because its effect is an absence; none may be deleted as cleanup |
| `PERMITTED_TOOLS`, `isPermittedTool(name)`, `toolDenial(name)` | `providers/claude-sdk/allowlist.ts` | Deciding whether the SDK subprocess may execute a tool **on this host**. One reviewed constant, closed by construction — a name not in it cannot run, whatever the SDK ships next. Never widen it without reading `docs/idea/07-security.md`; the host-tool-rejection test is a build gate |
| `subprocessEnv(options)`, `STRIPPED_ENV_PREFIXES`, `STRIPPED_ENV_NAMES`, `CLAUDE_CONFIG_DIR_VAR` | `providers/claude-sdk/env.ts` | Building the child environment for a spawn. Strips the `ANTHROPIC_*` family **by prefix** (a list would go stale and let the subprocess loop back through our own router), the CLI's own OAuth-token override, and the router's secrets; sets `CLAUDE_CONFIG_DIR` last. The SDK **replaces** rather than merges the child environment, so this is the whole of what the subprocess sees |
| `createSdkConcurrency(limits)` → `SdkConcurrency`, `SdkSlot` | `providers/claude-sdk/concurrency.ts` | Bounding `claude` subprocesses — a memory bound, not a throughput one. Per-Account gate acquired **before** global, so a bursting Account queues on its own budget instead of parking global capacity. Excess callers queue FIFO; an abort while queued throws the signal's own reason, so the wait classifies exactly as the call would |
| `renderSdkResponse(input)` → `Promise<Response>` | `providers/claude-sdk/render/stream.ts` | Turning a `query()` message stream into an Anthropic Messages response — streaming or not, from the same events. Discriminates on `message.type`: only `stream_event` payloads reach the client, `result` is the authoritative usage, `system`/`init` and `rate_limit_event` go to the observer and never to the wire. The status is settled **before** the first byte, so a stall on the way to it is a real `504` and a stall after it is a terminal `error` frame |
| `createEnvelope(options)` → `Envelope` | `providers/claude-sdk/render/envelope.ts` | Funnelling an SDK agent loop's several internal turns into **one** Anthropic message: one `message_start`, intermediate `message_delta`/`message_stop` dropped, one terminal `message_stop`. Frames come out as plain objects so the streaming and non-streaming halves cannot disagree. Never fabricates content, and a stop reason nobody stated is `null` |
| `createBlockIndexMap()` → `BlockIndexMap`, `withClientIndex(event, index)` | `providers/claude-sdk/render/index-map.ts` | Renumbering content blocks. Keyed on `(parent_tool_use_id, index)` — the SDK restarts indices per turn *and* a subagent has its own space, so an index-only map silently discards the answer. A filtered block loses its whole start/delta/stop triple because the decision is remembered here |
| `createMessageFold()` → `MessageFold` | `providers/claude-sdk/render/message.ts` | Folding the client-visible frames into one non-streaming body. Buffering is correct here: the client asked for one object, so no byte is delayed that could have gone out earlier |
| `createIdleGuard(input)` → `IdleGuard`, `StreamPacing`, `Ticker`, `DEFAULT_STREAM_PACING` | `providers/claude-sdk/render/idle-guard.ts` | The two stream clocks. `race()` puts a 90 s **upstream** deadline on every `next()` → `504`; the 15 s `: ping` is reset by a **write**, not by an SDK message, because most SDK messages produce no client bytes at all. Timers injected, so both are deterministic in a test |
| `readConversation(body)` → `ConversationView \| null`, `FIRST_USER_TEXT_LIMIT` | `providers/claude-sdk/session/conversation.ts` | Reading an Anthropic Messages body into one hashable string per message plus the first user text. Deliberately **not** the translator's schema: lineage must hash a block type nobody has heard of rather than refuse it, and `services/translate` sits above `providers/`. Strips `cache_control` and sorts keys, so a client that moves a cache marker or reorders JSON is not a divergence |
| `sessionFingerprint(seed)`, `scopedKey(scope, key)` | `providers/claude-sdk/session/fingerprint.ts` | The headerless client's session key: `sha256(cwd + "\n" + firstUserText[0:2000])[0:16]`, **scoped by Account**. Only the conversation's opening seeds it, because a growing history must keep its key |
| `classifyLineage(stored, incoming)`, `resolveLineage(input)` → `SessionPlan`, `hashMessages(messages)` | `providers/claude-sdk/session/lineage.ts` | The six lineage classes and the never-resume rules. Pure over two string arrays, so all six are asserted without an SDK. `replay` is deliberately not a resume, and compaction is matched **positionally** — a stored suffix, not set membership |
| `createSessionCache(options)` → `SessionCache` | `providers/claude-sdk/session/cache.ts` | The session/fingerprint cache pair with **coordinated eviction**: dropping one entry removes every entry in the other naming the same SDK session id. Misses are cached on their own shorter clock. Half-evicting the pair is what would resurrect a session the other side abandoned |
| `createSessionStore(deps)` → `SessionStore` | `providers/claude-sdk/session/store.ts` | Postgres behind the cache pair: `binding()` on the request path (hit or one indexed query), `resolve()` per SDK attempt, `remember()` fire-and-forget. A read or write failure degrades to "no binding" — a slow session table costs a cold prompt cache, never a request |
| `sessionBindings(catalog, store)` → `SessionBindings`, `sessionStoreFromEnv(deps)` | `services/dataplane/session-binding.ts` | The seam between the store and routing, plus the gate: a router with no subscription Account never queries, because only that path writes a binding. Populates `SelectionRequest.binding`, which `services/routing/binding.ts` already knew how to honor |
| `createSdkQuotaStore()` → `SdkQuotaStore`, `readSdkRateLimitInfo(info, now)`, `SDK_DEFAULT_BUCKET` | `providers/claude-sdk/quota.ts` | Folding `rate_limit_event` into Account quota state, and out the other side a `RateLimitSignal` the health store consumes exactly as it consumes an HTTP driver's. `utilizationSource` is always `threshold-triggered`, because the SDK populates `utilization` only near the limit. Created per runtime, keyed by Account — **never a module-level singleton**. Events with no window still cool the Account down without being rendered as one; a past reset is dropped rather than passed on as a cooldown of zero |
| `classifySdkFailure(error)` → `SdkFailure`, `readSdkFailure(error)`, `STDERR_TAIL_LIMIT` | `providers/claude-sdk/errors.ts` | Reading a class out of a `query()` throw — prose, not a status line. Ordered substring table over the message plus a bounded stderr tail, producing the same `FailureClassification` an HTTP driver does. A bare status token is matched in the **message only**, so a crash is never re-read as an auth failure; every class carries a router-authored sentence, so the SDK's own words never reach a client |
| `createPassthrough(input)` → `Passthrough \| null`, `readDeclaredTools(body)`, `DEFER_LOADING_THRESHOLD` | `providers/claude-sdk/tools/register.ts` | The one seam a `query()` launch consumes for tool passthrough: `mcpServers`, `hooks`, and a `filter()` that wraps the SDK's message stream. Null when the client sent no tools, which is the signal to launch without any of it. Registration is deduplicated and sorted **by code point** — order is the system prompt, and a prompt that differs by a line is a cache miss on the whole prefix |
| `createPassthroughServer(tools)`, `passthroughToolDefinition(tool)` | `providers/claude-sdk/tools/passthrough.ts` | The in-process MCP server the client's tools are declared on. Handlers **refuse and run nothing** — the registration exists so the model emits a well-formed `tool_use`, and the SDK's internal-MCP execution mode is disqualified permanently (`docs/idea/07-security.md`) |
| `createEarlyStop(input)` → `EarlyStop`, `DENY_HOLD_TIMEOUT_SECONDS` | `providers/claude-sdk/tools/early-stop.ts` | Making the agent loop behave as a single-turn endpoint: a `PreToolUse` hook that denies and captures every call, a **deny-hold** until `message_delta` (an early deny makes the CLI truncate parallel blocks), an abort once every emitted call is denied, and turn-2 suppression as the backstop. Ends the stream with a synthesized `result` carrying `stop_reason: "tool_use"` and no invented usage |
| `createToolRewriter(schemas)` → `ToolRewriter`, `MAX_BUFFERED_TOOL_INPUT` | `providers/claude-sdk/tools/rewrite.ts` | The two edits a `tool_use` block needs before a client can run it: the `mcp__client__` prefix off the name, and argument names repaired. Buffers **only** a tool block's `input_json_delta`s, because argument JSON splits mid-key; text and thinking stream untouched. Unparseable or oversized arguments are forwarded verbatim rather than dropped |
| `readToolSchema(input)` → `ToolSchema`, `repairToolInput(input, schema)`, `qualifyToolName`/`unprefixToolName` | `providers/claude-sdk/tools/` | The pure pieces: JSON Schema → the Zod raw shape MCP registration demands (unrepresentable keywords degrade to unconstrained, never guessed); the **case-only** rename, applied only when a *required* parameter is missing; and the single place the MCP prefix goes on and comes off, accepting both forms because the SDK sends both |
| `createClaudeCliLogin(options)` → `ClaudeCliLogin`, `ClaudeLoginHandle`, `ClaudeLoginError`, `LoginSpawn` | `providers/claude-sdk/login/spawn.ts` | Driving the `claude` CLI through its own login, one subprocess per Account. Two calls with a live child between them: `start` scrapes the authorization URL, `submit` writes the pasted `code#state` to its stdin. The PKCE verifier, the exchange, and the token stay on the far side of the subprocess — this side keeps the URL and the `state`. One reader drains the pipe for the child's whole life (a full pipe is a permanent hang), the window is bounded and redacted at the source, and every failure path kills the child |
| `findAuthorizeUrl(output)`, `readState(url)`, `parsePastedCode(pasted)`, `readAuthStatus(output)`, `CLAUDE_LOGIN_ARGV`, `CLAUDE_AUTH_STATUS_ARGV` | `providers/claude-sdk/login/scrape.ts` | Reading the CLI's output — the part most likely to break on a CLI release, kept pure so it needs no binary to test. Strips ANSI, requires a `state` before calling a URL complete (a chunked stream delivers half of one), refuses a paste that is not exactly `code#state`, and parses `auth status --json` into three fields, dropping the tenant identifiers it also prints. Unrecognised output is `null`, never a definite answer. The pinned subcommands and their provenance live here and nowhere else |
| `createClaudeAuthCheck(options)` → `ClaudeAuthCheck`, `ClaudeAuthStatus` | `providers/claude-sdk/login/status.ts` | `claude auth status` for one config directory: the cheapest honest answer to "is this Account still logged in", with no provider contacted and nothing billed. Same drained-pipe, bounded-window, bounded-exit shape as the login, and the same injected `LoginSpawn`. Every failure — missing binary, timeout, unparseable output — returns `null`, because a probe that mistook silence for "logged out" would drop healthy Accounts out of routing |
| `createCredentialGuard(fs)` → `CredentialGuard`, `CredentialState`, `CREDENTIALS_FILE` | `providers/claude-sdk/login/credentials.ts` | The compactness rule: `.credentials.json` must be minified or the CLI reads it as *logged out*, which fails every request against a subscription that is in fact connected. Settles the file after a login — absent, compact, re-minified, or unparseable. Returns a four-value enum and never a byte of the file; the only path that parses at all is the repair, and the parsed value never leaves the function |
| `createClaudeConnectService(deps)` → `ClaudeConnectService`, `ClaudeConnectMode` | `services/accounts/connect/claude.ts` | Connect and reconnect for a Claude subscription. Owns what the CLI does not: the `state` read back out of the authorize URL, one-shot (a wrong paste burns the login), TTL from `env.retention.oauthStateMinutes`, bound to one Account row. Pending logins are in memory because a pending login *is* a running subprocess. Clears `needs_reauth` and nothing else — a disabled Account stays disabled. `mode` only selects the audit kind: connect vs reconnect is declared by the operator, never detected |
| `claudeCliFromEnv(deps)` → `ClaudeCliStack` | `services/accounts/connect/fromEnv.ts` | The production wiring for both things that *run* the `claude` binary — the connect login and the credential probe — from one env, so only one module resolves the CLI. Resolution is per call, not at construction, so a fixed mount needs no restart. The halves disagree deliberately about a missing binary: connect fails and says so, the probe reports nothing |
| `createClaudeAuthProbe(deps)` → `AccountAuthProbe`, `ClaudeAuthReport` | `services/health/claudeAuthProbe.ts` | The Account-level credential check, and the single status transition it may drive: logged out moves `active` → `needs_reauth`, logged in clears `needs_reauth` → `active` and audits `account.reauthorized`. A `disabled` Account is never touched and a cooldown is left alone. Carried by "Re-check now" rather than a button of its own, and never by `/readyz` — it spawns a process per Account |
| `createAccountConfigDirs(options)` → `AccountConfigDirs`, `ConfigDirFs`, `ConfigDirError`, `CONFIG_DIR_MODE` | `providers/claude-sdk/config-dir.ts` | Naming, creating, and destroying an Account's `CLAUDE_CONFIG_DIR`. `pathFor` is pure and keyed on Account id; `provision`/`remove` are idempotent and bounded to `<root>/<id>`, so neither can reach a path the router did not mint. The filesystem is injected (`ConfigDirFs`), so a test asserts which directory an Account got without touching disk. Constructed once at boot — a root that is relative, or at/under the CLI's own `~/.claude`, throws there rather than at first use |
| `resolveEgress(ingress, account)` → `EgressDecision` | `services/dataplane/egress/mode.ts` | Asking what a (dialect, account) pair takes: `passthrough`, `translate`, `agent-sdk`, or a named rejection. The one place all three modes are decided |
| `planCandidates(candidates, catalog, ingress)` → `CandidatePlan` | `services/dataplane/plan.ts` | Turning routing's ordered candidates into dispatchable attempts. `kind` carries the transport: `http` with a `url`, `sdk` with a `configDir`. A chain may mix both |
| `runAttempt(input)` / `runSdkAttempt(input)` → `AttemptOutcome` | `services/dataplane/attempt.ts`, `sdk-attempt.ts` | Dispatching one attempt. Two transports, **one** outcome type, so health, records, and relay are written once. Siblings, never modes inside one function |
| `attemptDeadline(timeoutMs, clientSignal?)` | `services/dataplane/attempt.ts` | Bounding an upstream call. Shared by both transports: on the SDK path the same signal terminates the subprocess, so a client that disconnects never orphans one |
| `relayUpstreamError(upstream, ingress)` | `services/dataplane/relay-error.ts` | Rendering an upstream's own error. `null` ingress relays it unchanged (passthrough); a dialect re-renders it into the client's shape, naming no account |

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
| Per-key rate-limit accounting | `services/dataplane/limits.ts`, charged once per request in the dispatcher. A second counter — in a middleware, a route, or the verifier (which is cached, so it would only see misses) — double-charges or under-charges the same key |
| Which conversion serves a dialect pair | `services/translate/registry.ts`. A second lookup — in a route, a driver, or the relay — is how a request gets converted one way on the way out and a different way on the way back |
| How the `claude` binary is located | `providers/claude-sdk/resolve-cli.ts`. The Dockerfile stages the binary by *running* that resolver, never by hard-coding a store path: a second answer means the image ships one binary and the router spawns another, and the symptom is an unreadable SDK stderr string |
| Which transport serves a provider | `PROVIDER_REGISTRY[id].transport`, narrowed. A `provider === "anthropic-oauth"` check anywhere else is a second registry that will disagree with the first the moment a provider moves transports |

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
