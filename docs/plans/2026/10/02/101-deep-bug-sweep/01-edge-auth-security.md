# 01 — Edge, auth & security

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/dataplane/{orchestrator,runtime,records,observe,auth/verifier}.ts`, `apps/api/src/services/admin-auth/{service,throttle,postgresSessionStore,apiToken}.ts`, `apps/api/src/services/admin-auth/oidc/{flow,state}.ts`, `apps/api/src/routes/admin/auth.ts`, `apps/api/src/config/listen.ts`, `apps/api/src/main.ts`, `apps/api/src/services/dataplane/body/read.ts`, `apps/api/src/services/dataplane/{chain,chain-relay,attempt,sdk-attempt,plan,relay-error,quota-writer,status-writer}.ts`, `apps/api/src/services/dataplane/egress/headers.ts`, `apps/api/src/routes/v1/index.ts`, `docs/idea/{04-api-keys-and-access,07-security,08-observability,13-admin-oidc}.md` (rows touched below only).

## Findings
Severity order across both dives (numbering is chronological; dive 2 = 01.13+):
**high** 01.15 (NN 4), 01.13, 01.14, 01.1 · **medium** 01.16, 01.17, 01.2, 01.3, 01.4, 01.5 · **low** 01.18, 01.6, 01.7, 01.8, 01.9, 01.10, 01.11, 01.12, 01.19, 01.20, 01.21, 01.22, 01.23.

### 01.1 high — `router_overhead_ms` counts the client's body upload as router time (root cause of 06.1)
- **Where:** `apps/api/src/services/dataplane/orchestrator.ts:250-254` (`requestStarted` taken at dispatch entry) → `orchestrator.ts:75` (`await readRequestBody(...)` waits for the socket) → `runtime.ts:159-166` (`totalMs = elapsed - requestStarted`) → `records.ts:136` (`routerOverheadMs = totalMs - upstreamMs`). Same span feeds `observe.ts:41` (`durationMs`).
- **Defect:** the overhead clock starts before the request body has arrived, so time spent waiting on the *client's* upload is billed as router overhead; nothing in pre-dispatch work is body-size-dependent beyond a byte scan.
- **Evidence (code + measurement):** every pre-selection step traced: `refuseEncodedBody` (header read), `readRequestBody` (per-chunk byte scanner, stops after `model` + 1 KiB conversation prefix — `body/scanner.ts:128,247`), `resolveSessionKey` (SHA-256 of ≤1 KiB), `bindings.read` (warm cache; one indexed query on miss), `buildSnapshot`/`selectAccounts` (pure, never see the body). **No JSON parse, no re-serialize, no token estimation, no eager translation** before eligibility — `createTranslatedRequestBody` is lazy (`translate-body.ts`, only called from `chain.ts:263` per candidate). In-process bench (scratch, `readRequestBody` + `resolveSessionKey` on a 292 KB body from an in-memory `Request`): **0.63 ms/req model-first, 2.05 ms/req model-last**. Prod sees 188–223 ms for ~280 KB and 63–81 ms for ~75 KB ≈ a steady ~1.3 MB/s — a network upload rate, not CPU. Tiny `{}` bodies finish in 2–29 ms, consistent.
- **Failure scenario:** a `fleet-*` client (`Bun/1.3.14`, remote) posts 280 KB → handler starts at headers, `readRequestBody` awaits ~200 ms of TCP/TLS receive → all candidates cooling → 429; row records `router_overhead_ms≈200` though the router worked ~1 ms. Same inflation on every success, so the `<5 ms p99` budget (NN 8) is unmeasurable today; a real regression would hide in it.
- **Fix:** (1) in `orchestrator.ts` take `bodyReceived = clock.elapsed()` right after `readRequestBody` returns; carry `bodyReadMs = bodyReceived - requestStarted` on the runtime (`runtime.ts` `RuntimeInput`) and subtract it in `timing()` alongside `upstreamMs` (keep `totalMs`/`latencyMs` as is — the client still waited). (2) Record it: new nullable `usage_records.body_read_ms` (migration is slice 02's `packages/db`) and a `router_request_body_read_seconds` histogram (`observability/series.ts`), so slow uploads stay visible. (3) `records.ts:20` and `08-observability.md` `routerOverheadMs` row: state "measured from body received". (4) `bin/bench`: add a 280 KB-body scenario through a throttled stub client to pin both numbers. Outliers 1–2 s: likely slow uploads; **unverified** alternative — `bindings.read` miss (`session-binding.ts`, Postgres `findByKey`) under pool contention whenever any Agent-SDK account exists; log `bodyReadMs` and binding-miss latency separately to tell them apart.
- **Test:** unit (pure, injected clock) on `createRuntime().timing`: clock advances 200 ms during body read, 0 during routing → `routerOverheadMs === 0`, `latencyMs`/`totalMs` include 200. Integration: request body delivered via a `ReadableStream` that sleeps 150 ms between chunks, all candidates cooling → row `router_overhead_ms < 20`, `body_read_ms ≥ 150`.

### 01.2 medium — Logout can be undone by a racing fire-and-forget session slide (resurrected session)
- **Where:** `apps/api/src/services/admin-auth/service.ts:353-355` (slide `save` inside `authenticate`), `postgresSessionStore.ts:562-576` (slide = un-awaited `upsert`), `postgresSessionStore.ts:578-581` (`delete`), `packages/db/src/repositories/admin-session-repository.ts:48-56` (`insert … onConflictDoUpdate` — inserts when the row is gone).
- **Defect:** the guard on `POST /logout` slides the session (un-awaited upsert) and the handler then deletes it on a possibly different pool connection; if the upsert lands after the delete it re-INSERTs the row.
- **Failure scenario:** operator idle > `ADMIN_SESSION_TOUCH_INTERVAL_SECONDS` (60 s default — the common case) clicks Log out → guard issues upsert (not awaited) → handler `DELETE` → upsert commits second → row back with the full 30-day idle window. This replica's cache is cleared, so the next request on it, any restart, or another replica reads the row and the "logged-out" (possibly stolen) cookie authenticates again. Same race for any concurrent request + logout.
- **Fix:** make the slide an UPDATE-only write (`update … set lastSeenAt, idleExpiryAt where id_hash = ?`) — add `touch(row)` to `AdminSessionRepository` (slice 02 owns the file; one method) and call it from `postgresSessionStore.save` when `isSlide`; keep `upsert` for login only. Belt-and-braces: track a per-id `deleted` tombstone in the store so a slide after `delete` is dropped.
- **Test:** unit on `createPostgresSessionStore` with an in-memory repository whose `upsert` resolves after `delete`: login, slide, delete → `repository.find` returns undefined. Integration: logout then a restarted store (`get` on cold cache) → 401.

### 01.3 medium — Local-login throttle is check-then-act across the argon2 await; a burst bypasses the lockout
- **Where:** `apps/api/src/services/admin-auth/service.ts:291` (`check`) → `:304` (`await deps.local?.verify` — 64 MiB argon2id, `localCredential.ts:84-94`) → `:306` (`recordFailure`).
- **Defect:** the lockout is decided before the expensive await and charged after it, so N concurrent attempts all pass `check` before the first failure is recorded.
- **Failure scenario:** unauthenticated attacker sends 500 parallel `POST /api/admin/auth/login` from one IP → all 500 pass `check` (bucket empty) → 500 password guesses evaluated, lockout only applies to the *next* burst after 15 min. `ADMIN_LOGIN_MAX_ATTEMPTS=5` becomes ~"unbounded per window". Also 500 × argon2 queued on the threadpool with no concurrency cap — CPU starvation of the data plane in the same process (memory bounded by Bun's worker count, unverified).
- **Fix:** charge before verifying: in `throttle.ts` add `reserve(keys, now)` that counts an in-flight attempt against `maxFailedAttempts` (refuse when `failures + inFlight ≥ max`), `release` on success (then `reset`) or convert to a failure. Cap concurrent local verifies globally (small semaphore, configurable `ADMIN_LOGIN_MAX_CONCURRENT`, NN 11) and answer the overflow with the same 429 + generic body.
- **Test:** unit on the service with a `local.verify` that resolves on a manually released promise: fire 10 concurrent `completeLocalLogin` (max 5) → ≥5 reject with `AdminLoginThrottledError` before any verify resolves.

### 01.4 medium — Revocation race: a verification in flight across `revoke` re-caches the revoked key for the full TTL
- **Where:** `apps/api/src/services/dataplane/auth/verifier.ts:135-151` (`await findUsableByPrefix` … `await loadScope` … `remember`), `:156-159` (`invalidate`), `services/admin/coherence.ts:104`.
- **Defect:** `invalidate(keyId)` only drops digests already in `byKeyId`; a cache-miss `verify` whose query ran before `markRevoked` committed calls `remember(ok)` after the invalidation, caching the revoked key for `DEFAULT_KEY_CACHE_TTL_MS` (60 s).
- **Failure scenario:** cold cache (boot, eviction, or first use in 60 s) → request R1 with key K reads the row (not revoked) → operator revokes K, `invalidate(K)` finds nothing → R1 `remember`s K → every request with K for the next 60 s is admitted. Contradicts "Immediate for new requests" (`04-api-keys-and-access.md:227`). Same for a scope-narrowing `update` (stale wider scope cached 60 s — a widening of scope, NN 6).
- **Fix:** per-key generation counter in the verifier: `invalidate` bumps `generation[keyId]` (and a global epoch for `invalidateAll`); `verify` captures the epoch before the query and skips `remember` (still returns the key for this one in-flight request, or refuses — prefer refuse to keep the spec's "immediate") when it changed. Keep `byKeyId` cleanup.
- **Test:** unit (pure, stub repository with a deferred promise): start `verify`, call `invalidate(id)`, resolve the query → a second `verify` hits the repository again (returns revoked → 401).

### 01.5 medium — Unauthenticated `/oidc/start` writes a Postgres row per hit; OIDC has no throttle despite docs; discovery/JWKS fetch has no timeout
- **Where:** `routes/admin/auth.ts:107-111` → `oidc/flow.ts:308-310` → `oidc/state.ts:82-93` (`oauth_states` INSERT). `oidc/flow.ts:209-217` — `discoveryFetch` builds an `AbortController` + 10 s timer but never passes `controller.signal` to `execFetch(url, init)`; JWKS reuses it (`:260`). `oidc/state.ts:116` `ipThrottleNamespace` is dead code.
- **Defect:** OIDC entry is unthrottled and unbounded (one encrypted DB row per anonymous GET), and an IdP that hangs on discovery/JWKS hangs `/oidc/start` and the callback forever.
- **Failure scenario:** `while true; curl /api/admin/auth/oidc/start` → thousands of `oauth_states` rows/minute until the janitor's next sweep; DB pool contention reaches the data plane's binding/key-miss queries. IdP outage with a black-holed TCP → every login request pins a handler indefinitely.
- **Fix:** pass `signal: controller.signal` (merge with `init?.signal`) in `discoveryFetch`; make the 10 s / 15 s timeouts env (`ADMIN_OIDC_HTTP_TIMEOUT_MS`, NN 11). Run `/oidc/start` and `/oidc/callback` through the same per-IP `LoginThrottle` (charge on start, reset on successful callback) — or delete the docs claim. Remove `ipThrottleNamespace` or use it.
- **Test:** unit on `createOIDCFlow` with a `fetch` that never resolves and an injected short timeout → `start()` rejects with `AdminAuthError` reason `discovery:…`. Unit: 6 starts from one IP with max 5 → 429.

### 01.6 low — Pre-dispatch router-refused requests record `http_status = NULL` (06.3)
- **Where:** `apps/api/src/services/dataplane/orchestrator.ts:120-131` (`fail()` passes `httpStatus: null`).
- **Defect:** by spec, not by accident: `docs/idea/08-observability.md:37` defines `httpStatus` as the **upstream** status and says NULL for "a pool-wide cooldown's 429". The client-facing status is derivable from `error_class` (`QuotaExhaustedError` → 429) but nothing stores it, so status-grouped queries misreport.
- **Failure scenario:** all candidates cooling → client gets 429 + `Retry-After`; row `http_status NULL, account_id NULL`; a "requests by status" panel puts it in "unknown".
- **Fix:** do **not** overload `http_status` (it would make "upstream answered" indistinguishable from "router refused"). Add `response_status smallint` (slice 02 migration), set it in `fail()` from `error.status`, in `chain.ts:242-249` from the thrown/relayed status for the final attempt row, and in `chain-relay.ts` for successes; document in `08-observability.md:37`. If no column is wanted, close 06.3 as "by design" and fix the console query to map `error_class`.
- **Test:** integration (mocked upstream, all accounts `cooling_down`) → one `UsageRecord` with `outcome=quota_exhausted`, `http_status NULL`, `response_status 429`.

### 01.7 low — Authenticated requests refused before a model is named write no `UsageRecord` (06.4)
- **Where:** `apps/api/src/services/dataplane/orchestrator.ts:68-81` — key-rate-limit (`:69`), `refuseEncodedBody` (`:73`), `readRequestBody` 413 (`:75`), `modelTooLong` (`:80`), `missingModelError` (`:81`) all throw before `progress.model`/`runtime` exist; the module comment (`:34-40`) documents the exclusion (model column NOT NULL).
- **Defect:** CLAUDE.md Testing requires "a UsageRecord row per request, including failures"; the code deliberately skips these and only counts them on `router_requests_total`, which is in-memory per replica and not per key in the console.
- **Failure scenario:** one fleet key posts `{}` every ~8 min → 57 × 400 `invalid_request`, zero rows; the console's per-key failure view shows the key healthy.
- **Fix:** record them with a sentinel model constant from core (e.g. `UNNAMED_MODEL = ""`, never shown as a model in rollups — `usage_daily` rollup must skip or bucket it; coordinate with slice 02), `outcome=client_error` (or `key_rate_limited`), `errorClass`, `account_id NULL`. Build a minimal preflight runtime before the body read so `fail()` is reusable (move `createRuntime` above `:68` with `model` set later, or a small `preflightRecord(input, error)` helper in `records.ts`). Update `orchestrator.ts:34-40` and `08-observability.md`. Alternative: keep exclusion and amend CLAUDE.md + 08 explicitly — pick one; today they disagree.
- **Test:** integration: authenticated `POST /v1/messages` body `{}` → 400 and exactly one row `error_class=InvalidRequestError`, `api_key_id` set, `account_id NULL`.

### 01.8 low — Admin `/login` (unauthenticated) and every admin JSON route read bodies with no cap; `MAX_REQUEST_BODY_BYTES` > Bun's default is silently capped
- **Where:** `routes/admin/auth.ts:71` → `services/admin/parse.ts:13-19` (`request.json()` unbounded); `config/listen.ts:15-17` passes no `maxRequestBodySize`, so Bun's default (128 MiB per Bun docs, unverified on 1.4) applies; `config/env.ts:809` has no upper bound on `MAX_REQUEST_BODY_BYTES`.
- **Defect:** an anonymous caller can make the process buffer and JSON-parse up to Bun's default per request on `/api/admin/auth/login`; and an operator setting `MAX_REQUEST_BODY_BYTES=200MiB` gets Bun's plain 413 (not dialect-shaped, no log line) above 128 MiB.
- **Failure scenario:** 30 parallel 120 MB POSTs to `/login` → ~3.6 GB buffered + parsed → OOM kills the router and its in-flight streams.
- **Fix:** set `maxRequestBodySize` in `listenOptions` to `max(maxRequestBodyBytes, adminBodyCap)` + small slack; add `ADMIN_MAX_BODY_BYTES` (default 1 MiB) and make `readJsonBody` read through the same bounded reader as `body/read.ts` (`declaredBodyBytes` + streaming ceiling), returning `invalid`/413.
- **Test:** unit on `readJsonBody` with a 2 MiB stream and 1 MiB cap → rejected without buffering past the cap; unit on `listenOptions` asserts `maxRequestBodySize ≥ maxRequestBodyBytes`.

### 01.9 low — Throttle map is not actually bounded
- **Where:** `services/admin-auth/throttle.ts:70-83`.
- **Defect:** at `MAX_TRACKED_KEYS` it evicts only *expired* buckets, then inserts anyway; live buckets grow without limit.
- **Failure scenario:** IPv6 spray (one failed login per /128) → map grows by one entry per address for the whole attempt window.
- **Fix:** after `evictStale`, if still at cap, drop the oldest insertion (Map order), as `limits.ts:93-100` already does.
- **Test:** unit: cap 3, 5 failures from 5 keys within the window → `size ≤ 3`.

### 01.10 low — A client that aborts mid-upload is a generic `500` + Sentry event
- **Where:** `services/dataplane/body/read.ts:341-354` — `reader.read()` rejection is not a `RouterError`, so `errors/render.ts:409-416` renders 500 and `middleware/errorHandler.ts:294-305` captures it.
- **Defect:** a client disconnect is reported as a router defect (NN 7: "never a generic 500").
- **Failure scenario:** agent cancels while uploading a 5 MB transcript → `level=error request failed` + GlitchTip event per cancel.
- **Fix:** catch the read rejection in `readRequestBody` and throw an `InvalidRequestError("request body was not fully received")` (or a new `ClientClosedRequestError`, 499, in core) — no Sentry.
- **Test:** unit: `readRequestBody` over a stream that errors after one chunk → throws a `RouterError` with status < 500.

### 01.11 low — Caller-supplied UUID `x-request-id` becomes the router's correlation id
- **Where:** `middleware/requestId.ts:167-175` honours any safe id; `services/usage/record.ts:111-113` treats a UUID as router-minted.
- **Defect:** contradicts `orchestrator.ts:107-110` ("using the [client id] as the join key would merge two clients' chains").
- **Failure scenario:** two agents both forward trace id `123e4567-…` → their attempt rows share `correlation_id`; per-request counts (distinct correlation id) under-count and the console's chain view merges them.
- **Fix:** mint the correlation id always (`crypto.randomUUID()`), keep the client's value in `client_request_id` whatever its shape; separate `c.get("requestId")` (echoed header) from the correlation id.
- **Test:** unit on `correlationIdFrom`/`clientRequestIdFrom`: client UUID → correlation id ≠ client id, client id preserved.

### 01.12 low — Any key `update` (even a rename) resets the key's rate-limit window
- **Where:** `composition/index.ts:460-464` (`invalidateKey` also calls `limiter.forget`), `services/admin/coherence.ts:102-103`.
- **Defect:** forget is right for revoke/delete, wrong for update; `limits.ts:112` already restarts the window when the ceiling itself changes.
- **Failure scenario:** key at 60/60 s ceiling; operator renames it → next 60 requests admitted immediately (120 in the window).
- **Fix:** split the hook: `invalidateKey` (verifier only) for update, `forgetKey` (verifier + limiter) for revoke/remove.
- **Test:** unit on `withKeyInvalidation` with spy hooks: update calls verifier-invalidate only.

---
*Dive 2 (01.13+).*

### 01.15 high — Alias map applied twice: the model sent upstream is not the one routing approved (NN 4)
- **Where:** `services/routing/filter.ts:115-122` sets `candidate.upstreamModel = resolveModel(...)` (`routing/model.ts:27-29`, alias applied) → `services/dataplane/plan.ts:156` runs `egress.driver.mapModelAlias(account.driver, candidate.upstreamModel)` on the **already-aliased** name (`providers/model-alias.ts:13-16`). Both read the same `accounts.model_aliases` row (`services/catalog/load.ts:98,113`).
- **Defect:** any alias map whose target is itself a key is applied transitively; the `supported` check validated the first hop, the wire gets the second.
- **Failure scenario (reproduced in scratch):** `modelAliases = {sonnet: "glm-4.7", "glm-4.7": "glm-4.7-air"}`, `supportedModels = ["glm-4.7"]`; client asks `sonnet` → routing: `glm-4.7`, supported → upstream receives **`glm-4.7-air`** (a model the client never named, the operator never mapped `sonnet` to, and the account does not declare). Equally a client asking `glm-4.7` directly is silently downgraded. The comment at `routing/model.ts:53-55` describes exactly this map shape as legitimate. Usage records `upstream_model = glm-4.7-air`, so cost is attributed to the substitute.
- **Fix:** one application. Drop the `mapModelAlias` call in `plan.ts:156` and use `candidate.upstreamModel` verbatim (routing is the only place an alias resolves); delete `mapModelAlias` from the driver interface if nothing else needs it (`providers/driver.ts`, `claude-sdk/driver.ts:71,96` — slice 03 owns those lines). Add a guard test that no other module calls `mapModelAlias`.
- **Test:** unit on `planCandidates` with the map above and requested `sonnet` → `servable.upstreamModel === "glm-4.7"`; integration (mocked upstream) asserts the forwarded body's `model` is `glm-4.7` and the `UsageRecord.upstream_model` matches.

### 01.13 high — A client that disconnects before the first byte strikes every account in the chain as a `timeout`
- **Where:** `services/dataplane/attempt.ts:191-194` (`AbortSignal.any([timeout, client])`) → `attempt.ts:174-182` (`AbortError` → `kind: "timeout"`); SDK path `sdk-attempt.ts` `isDeadline` (`name === "AbortError"` → `failure("timeout")`). `chain.ts:188-195` then `health.recordFailure(timeout)` and, since `timeout` is retryable (`routing/failover.ts:71-79`), `planNextAttempt` moves to the next candidate with the **same already-aborted signal** → its fetch/SDK invoke aborts instantly → another `timeout` strike. Nothing in `chain.ts`/`orchestrator.ts` checks `request.signal.aborted` (grep: zero hits).
- **Defect:** the caller giving up is classified as the account failing, then propagated across the whole candidate list.
- **Failure scenario:** Claude Code user presses Esc during a long SDK TTFT (or any client-side timeout fires) on a 5-account pool → 5 attempts in ~1 ms, 5 `upstream_timeout` UsageRecords, 5 breaker strikes; three cancels in a row (breaker threshold) cool every account down → the next real request gets 429/503 from a healthy pool (NN 7 violated: a clock-recoverable state invented from nothing). Each SDK candidate also pays a subprocess spawn/abort.
- **Fix:** in `chain.ts` before each attempt and after each failure: if `ctx.request.signal.aborted`, stop the loop, `endAttempt`/`probe.release()` without `recordFailure`, write one row with a new outcome `client_cancelled` (core `UsageOutcome`, fault = caller), and return/throw a non-5xx (e.g. a core `ClientClosedRequestError`, 499, never Sentry). In `transportFailure`/`isDeadline` distinguish `signal.reason` (the timeout signal's `TimeoutError`) from the client's abort instead of matching on `name`.
- **Test:** unit on `runChain` with a stub fetch honouring the signal and an `AbortController` aborted mid-attempt, 3 candidates → exactly 1 attempt, `health.recordFailure` never called, one row `outcome=client_cancelled`. Integration: client aborts the fetch at 50 ms against a 500 ms mocked upstream → account health still `active`, one UsageRecord.

### 01.14 high — Bun's `idleTimeout` (60 s) kills any non-streaming / silent-upstream request that takes longer — feeding 01.13
- **Where:** `config/listen.ts:15-17`, `main.ts:104` (`idleTimeout: env.serverIdleTimeoutSeconds`, default 60, `config/env.ts:458`). The rationale (`env.ts:455-479`) only considers streams that carry the 15 s heartbeat. Non-streaming JSON responses have no heartbeat; passthrough streams only get bytes when the upstream sends them (`relay.ts` adds none; `relay-translate.ts:157-161` heartbeats only when an upstream chunk arrives).
- **Defect:** Bun's idle clock runs while the handler is still awaiting the upstream; verified on Bun 1.4.0 (scratch: `idleTimeout: 2`, handler sleeps 7 s → client socket closed at ~4 s, `req.signal` aborted).
- **Failure scenario:** `POST /v1/messages` with `stream:false`, Opus generating 8k tokens (~90 s) → at 60–64 s Bun closes the socket → client sees "socket closed unexpectedly" → `req.signal` aborts → 01.13 marks the account `timeout` and walks the chain. `UPSTREAM_TIMEOUT_MS=600000` (`09-deployment.md:197`, "a long completion is a normal response") is unreachable for any non-streaming call.
- **Fix:** for data-plane inference routes, hand the deadline to `UPSTREAM_TIMEOUT_MS` instead of the idle sweep: in `routes/v1/index.ts` (or `routerKeyAuth`) call Bun's per-request `server.timeout(c.req.raw, 0)` (the Bun server is `c.env` under `Bun.serve({ fetch: app.fetch })`; type it in `AppEnv`). Keep the global idle timeout for everything else. Optionally add an upstream-silence guard for passthrough streams (`UPSTREAM_IDLE_TIMEOUT_MS`, NN 11) so a stalled upstream is cut on our clock, not by the 600 s total deadline.
- **Test:** integration (real `Bun.serve` with `idleTimeout: 2`, mocked upstream replying after 5 s, `stream:false`) → client receives 200; current code fails with a socket close.

### 01.16 medium — A stream that broke mid-way (upstream error, deadline, or client gone) is recorded as `success`
- **Where:** `services/dataplane/chain-relay.ts:103-105` (`onError: () => settle(true)`) → `settle` always writes `outcome: SUCCESS_OUTCOME`, `errorClass: null` (`:90-93`); `chain.ts:159` already called `health.recordSuccess` at headers. Core says `success` = "Bytes were relayed and the upstream did not signal an error" (`packages/core/src/domain/usage.ts:26`); `05-routing-and-failover.md:362-365` "surfaces the truncation as an error".
- **Defect:** truncations are indistinguishable from completions in usage, metrics and health; a provider that 200s and dies mid-stream is never struck.
- **Failure scenario:** upstream resets the connection after 2 KB, or the 600 s `UPSTREAM_TIMEOUT_MS` signal (still attached to the response body via the request signal, `attempt.ts:80`) fires mid-generation → client gets a cut stream, row says `success`, account stays healthy and keeps receiving traffic; a client abort mid-stream also reads as `success`.
- **Fix:** `settle(streamed, error?)`: on `onError` record `outcome = upstream_error` (or `upstream_timeout` when the reason is the deadline, `client_cancelled` when `request.signal.aborted`), `errorClass` set, tokens as observed; call `health.recordFailure(server-error)` only for upstream-side breaks (never for client cancels). Same in `relay-translate.ts:193-195` path (shares the observer). Upstream is cancelled correctly already (`pipeTo` default `preventCancel:false`; SDK `releasingWith.cancel`, `sdk-attempt.ts`).
- **Test:** unit on `relaySuccess` with an upstream `ReadableStream` that errors after one chunk → recorded row `outcome !== "success"`; with a client-cancelled readable → `client_cancelled`, no health failure.

### 01.17 medium — Headers are forwarded by blocklist in both directions: upstream org/project ids and rate-limit tiers reach key holders; client `OpenAI-Organization`/`OpenAI-Project` reach the upstream
- **Where:** `services/dataplane/egress/headers.ts:40-46,65-72` (`clientHeaders` strips only hop-by-hop, encoding/length, `set-cookie`); used by `relay.ts:306` on every passthrough success. Request side: `upstreamHeaders` (`:48-63`) forwards every client header except auth/framing.
- **Defect:** NN 3 / `07-security.md:19` ("a client key holder … cannot enumerate other … accounts") — the response carries `anthropic-organization-id`, `openai-organization`, `openai-project`, `openai-processing-ms`, upstream `request-id`/`x-request-id`, `anthropic-ratelimit-*`/`x-ratelimit-*` (the account's tier and remaining budget), `cf-ray`, `server`, `via`. Identifiers, not credentials, but they fingerprint which upstream org/account served each request and expose its limits — the router's account abstraction is meant to hide that. Inbound, a client can send `OpenAI-Organization`/`OpenAI-Project` and steer billing of a multi-org account key to an org the operator did not choose (same finding reported independently by slice 03; billing impact unverified — depends on the account key having access to more than one org/project).
- **Failure scenario:** a key scoped to pool A replays requests and collects `anthropic-organization-id` + `anthropic-ratelimit-tokens-limit` values → maps how many distinct upstream orgs exist and their tiers; a contractor holding an `openai` key sets `OpenAI-Project: proj_internal` → spend lands on another project of the operator's key.
- **Fix:** explicit **response allowlist** in `headers.ts`: `content-type`, `cache-control`, `retry-after`, `x-router-*` (our own), plus a per-dialect set of client-meaningful protocol headers (`anthropic-version`? no — only what SDKs read for behaviour: `retry-after-ms`). Everything else dropped; the router's own `x-request-id` stands. Request side: add `openai-organization`, `openai-project`, `x-forwarded-*`, `forwarded`, `cf-*` to `STRIP_FROM_REQUEST` (drivers set org/project from account config if ever needed). Headers only — the passthrough body is still never touched (NN 10).
- **Test:** unit on `clientHeaders` with a header set containing each leaked name → only allowlisted survive; unit on `upstreamHeaders` that client `OpenAI-Organization` is dropped. Integration: passthrough response from a mocked upstream carrying `anthropic-organization-id` → absent at the client, body byte-identical.

### 01.18 low — `ADMIN_SESSION_TOUCH_INTERVAL_SECONDS ≥` idle window logs an active operator out
- **Where:** `services/admin-auth/service.ts:336,353-355`; `postgresSessionStore.ts:552-554` returns the cached *persisted* session; no cross-field check in `config/env.ts:787-792,1063-1068`.
- **Failure scenario:** `ADMIN_SESSION_IDLE_MINUTES=1`, touch 60 s (default) → persisted at t0, requests every 10 s never persist (delta < 60), expiry check uses persisted `idleExpiry = t0+60` → 401 at t0+60 mid-work.
- **Fix:** refuse at boot unless `touchInterval < idleMinutes*60` (env cross-refinement, beside the existing 5 `addIssue`s).
- **Test:** unit `parseEnv` with idle=1, touch=60 → `EnvValidationError` naming both.

### 01.19 low — Passthrough upstream error bodies are relayed unscrubbed
- **Where:** `services/dataplane/relay-error.ts:371-373` (ingress null → `bodyText` verbatim); the translate branch scrubs via `renderErrorBody` → `redactValue` (`errors/render.ts:402`).
- **Assessment:** 401/403/402/429 never take this path — `classify.ts` `verdictForStatus` maps them to `auth`/`credits`/`rate-limited` and `chain-error.ts:183-184` throws the router-shaped error, so OpenAI's masked-key 401 ("…sk-proj-****abcd") is **not** relayed. Remaining exposure: a provider rule reclassifying a 401/403 (e.g. the Kimi 403 = quota rule, #139) or an echoing 400/404/422/5xx. No observed provider echoes the full key there — unverified leak, but no scrub stands in the way, contrary to "one choke point" (`errors/render.ts:334-338`). Masked fragments (`****abcd`) are not reconstructable secrets; the redactor does **not** match them (`sk-[A-Za-z0-9_-]{8,}` stops at `*`), so they can appear in `upstreamMessage` log fields (`attempt-log.ts:29`) — acceptable per NN 3 only if 07-security.md says so; it does not today.
- **Fix:** apply `redactValue` to `bodyText` in the passthrough branch of `relayUpstreamError` (error bodies are already fully buffered strings — this is not parsing a passthrough body) and to `UpstreamError.bodyText` before logging; add a sentence to `07-security.md` on masked fragments.
- **Test:** unit `relayUpstreamError({status:400, bodyText:'{"error":{"message":"bad key sk-ant-api03-AAAAAAAAAAAA"}}'}, null)` → body contains `[REDACTED]`, not the key.

### 01.20 low — Upstream error bodies are read unbounded
- **Where:** `attempt.ts:196-201` (`response.text()`), `sdk-attempt.ts` `errorResponseFailure`.
- **Failure scenario:** a misbehaving gateway answers 502 with a 500 MB HTML page → buffered whole per attempt, ×N concurrent.
- **Fix:** read through a bounded reader (e.g. 64 KiB, config `UPSTREAM_ERROR_BODY_MAX_BYTES`), cancel the rest.
- **Test:** unit: 10 MB error stream → `bodyText.length ≤ cap`, stream cancelled.

### 01.21 low — Streams abandoned at the drain deadline lose their UsageRecord
- **Where:** `main.ts:121-126` → `services/shutdown/drain.ts:105-110` returns, `runtime.stop()` flushes usage, `process.exit(0)`; an abandoned stream's `settle` (`chain-relay.ts:69-96`) never ran, so its row is not in the queue.
- **Failure scenario:** SIGTERM with a 10-min generation in flight, `SHUTDOWN_DRAIN_MS` 25 s → client truncated, no usage row, tokens unbilled; `drain.ts:29-33` claims it is "counted and logged" — counted only as a log number.
- **Fix:** track open relays in a registry; on drain timeout, force `settle` (`outcome=upstream_error`/`router_shutdown`, tokens so far) before `runtime.stop()`.
- **Test:** unit: open relay + drain timeout → registry settle writes one row.

### 01.22 low — Writers' `stop()` can skip readings recorded during an in-flight drain
- **Where:** `quota-writer.ts`/`status-writer.ts` `flush()` returns the existing `inFlight` promise; `stop()` awaits it once (`stop → await flush()`), so entries added to `pending` after that drain snapshotted its batch are never written. Failed writes are dropped, not re-queued.
- **Failure scenario:** interval tick starts a drain → an account goes `exhausted` → SIGTERM → `stop()` awaits the old drain only → restart serves the dead account as `active` (the status-writer comment says this is exactly what it exists to prevent).
- **Fix:** in `stop()`, loop `await flush()` until `pending.size === 0` (bounded by a few passes); re-queue a failed status write if nothing newer is pending.
- **Test:** unit with a repository whose first `updateStatusWhen` is deferred; `record` during it; `stop()` → both written.

### 01.23 low — A client's `anthropic-beta` is replaced, not merged, on Anthropic OAuth-credential HTTP accounts
- **Where:** `egress/headers.ts:58-60` (`headers.set` driver-last) + `providers/auth-headers.ts:75-77` (`anthropic-beta: oauth-2025-04-20`).
- **Failure scenario:** client sends `anthropic-beta: context-1m-2025-08-07,interleaved-thinking-…` → upstream gets only the OAuth beta → 1M context / interleaved thinking silently off; passthrough is supposed to keep unknown betas (`headers.ts:4-6`).
- **Fix:** for `anthropic-beta` only, union the client's comma list with the driver's (driver value still guaranteed present).
- **Test:** unit `upstreamHeaders` with both → header contains both tokens.

## Steps
1. 01.15 double alias (NN 4 — one-line removal, ship first).
2. 01.13 + 01.14 together (client cancel ≠ account failure; per-request idle timeout off).
3. 01.16 truncation outcome (shares the cancel classification from step 2).
4. 01.1 overhead measurement (06.1).
5. 01.17 response/request header allowlist.
6. 01.2 session resurrection, 01.4 revocation race.
7. 01.3 throttle reserve + concurrency cap, 01.9 bound, 01.18 touch/idle check.
8. 01.5 OIDC timeout signal + throttle (or doc retraction).
9. 01.8 body caps, 01.10 abort mapping, 01.20 error-body cap, 01.19 passthrough-error scrub.
10. 01.6 / 01.7 usage-row decisions (slice 02 migration; `08-observability.md` same PR).
11. 01.21, 01.22, 01.11, 01.12, 01.23.

## Tests
- `bun test apps/api/src/services/dataplane/runtime.test.ts apps/api/src/services/dataplane/auth/verifier.test.ts apps/api/src/services/dataplane/body/read.test.ts apps/api/src/services/admin-auth/ apps/api/src/services/admin/coherence.test.ts apps/api/test/integration/<dataplane-usage>.test.ts` (new cases above; adjust names to the files that exist).
- `bunx biome check apps/api/src/services/dataplane apps/api/src/services/admin-auth apps/api/src/services/admin apps/api/src/routes/admin apps/api/src/config apps/api/src/middleware`
- `bun run typecheck` once.
- `bin/bench` with the new large-body scenario.

## Done when
- Pre-dispatch 429 for a 280 KB body records `router_overhead_ms` < 5 and a separate body-read figure ≈ upload time.
- A logged-out session cannot authenticate after any interleaving of slide and delete.
- N concurrent local logins from one IP never evaluate more than `ADMIN_LOGIN_MAX_ATTEMPTS` passwords per window.
- A key revoked during an in-flight cache-miss verification is refused on the next request.
- OIDC discovery/JWKS honour a timeout; OIDC entry is throttled or the docs say it is not.
- No request ever sends upstream a model other than `alias(requested)` applied once.
- A client cancel (before or after first byte) never strikes an account and records `client_cancelled`; a 90 s `stream:false` request completes.
- A truncated stream never records `success`.
- Passthrough responses carry only allowlisted headers; client org/project headers never reach the upstream.
- 06.3/06.4: either rows exist with the client status / for model-less refusals, or CLAUDE.md + `08-observability.md` state the exclusion — no contradiction left.

## Falsified doc claims
- `docs/idea/04-api-keys-and-access.md:4` ("OIDC callback throttling") and `apps/api/src/services/admin-auth/apiToken.ts:176-181` ("rate-limited by client IP before OIDC state creation or code exchange") / `throttle.ts:5-8` — only `completeLocalLogin` uses the throttle (`service.ts:281-315`); `routes/admin/auth.ts:107-157` OIDC routes have none.
- `docs/idea/04-api-keys-and-access.md:227` "Revocation … Immediate for new requests" — false under 01.4 (`verifier.ts:135-151`).
- `docs/idea/07-security.md:157` / `13-admin-oidc.md:49` "lock after `ADMIN_LOGIN_MAX_ATTEMPTS`" — not under concurrency (01.3).
- `postgresSessionStore.ts:492-495` "a logout … deletes the row" — the row can be re-inserted (01.2).
- `oidc/flow.ts:209-217` implies a 10 s discovery timeout — the signal is never attached (01.5).
- CLAUDE.md Testing "UsageRecord row per request, including failures" vs `orchestrator.ts:34-40` — the two disagree (01.7).
- `docs/idea/09-deployment.md:197` `UPSTREAM_TIMEOUT_MS` "how long the router waits on one upstream" (600 s) — a non-streaming request is cut by Bun's 60 s idle clock first (01.14, verified on Bun 1.4.0).
- `packages/core/src/domain/usage.ts:26` `success` = "upstream did not signal an error" and `05-routing-and-failover.md:365` "surfaces the truncation as an error" — `chain-relay.ts:105` records truncation as `success` (01.16).
- `routing/failover.ts:9` treats "timeout" as an upstream fault; client aborts are classified the same (01.13).
- `07-security.md:19` (key holder cannot enumerate accounts) — upstream org/project/rate-limit headers are relayed (01.17).
- `services/shutdown/drain.ts:29-33` "counted and logged" — abandoned streams write no UsageRecord (01.21).
- `routing/model.ts:5-6` "the router only renames it where an operator said so" — transitive rename (01.15).
- `records.ts:20` / `08-observability.md` overhead definition ("router-observed time minus upstream wait") silently includes client upload (01.1).

## Not covered
- Dive 2 read: `chain-relay.ts`, `translate-body.ts`, `sdk-attempt.ts`, `status-writer.ts`, `quota-writer.ts`, `catalog-listing.ts` (scope use only — reuses `resolveScope`, no widening seen), `relay-error.ts`, `egress/headers.ts`, `routing/model.ts`, `providers/model-alias.ts`, `failure/classify.ts`, `failure/router-error.ts`. Not read: `relay-translate.ts` beyond the heartbeat/settle (slice 04), `providers/claude-sdk/render/*` idle guard (slice 03), `health.ts`/breaker internals (slice 02).
- `config/env.ts`: field primitives (`fields.ts`) reviewed — `atLeastOne`/`ZERO_IS_LEGAL` drift guard holds, whitespace/empty → default via `compact` (`env.ts:1121-1129`) is deliberate; every `raw.X ?? default` cross-checked against `09-deployment.md` table: no mismatches (four vars documented in 05/08 instead of 09 — fine). Only cross-field gap found is 01.18. Hard-coded knobs left in my area: OIDC 10 s/15 s fetch timeouts (01.5), `MAX_TRACKED_KEYS` (throttle), `MAX_ECHOED_ENCODING`, `MAX_CHAIN_MESSAGES` — bounds, not policy; only the OIDC timeouts warrant config.
- NN 4 sweep: no case folding, prefix stripping or `-latest` handling on the request path; translators set `model` from `upstreamModel` (`translate-body.ts:237`); response `model` fields echo the upstream's name back (aliased name visible to the client — by design?). Only defect: 01.15.
- Cross-replica coherence (key cache, admin session cache, rate limiter) — docs declare single-replica; not filed.
- Whether Hono merges the router's `x-request-id` over an upstream `x-request-id` on a returned `Response` — unverified; covered by the 01.17 allowlist either way.

## Cross-area suspicions (not deep-dived)
- Slice 03/accounts: OAuth (Codex) connect/reconnect writes new `authMaterial` + `needs_reauth→active` (`services/accounts/connect/oauth-exchange.ts:142`) but `connectFromEnv` (`connect/fromEnv.ts:147-166`) wires no `refreshCatalog`/health reset (Claude path does, `connect/claude.ts:274`) → up to `CATALOG_REFRESH_SECONDS` (30 s) routing with the old token/status.
- Slice 02: `admin-session-repository.ts:48-56` needs the update-only `touch` for 01.2; `usage_records` columns for 01.1/01.6/01.7.
- Slice 03: `claude-sdk/driver.ts:71,96` / `providers/driver.ts` `mapModelAlias` becomes dead after 01.15. SDK render idle guard (90 s) vs Bun idle (60 s) for non-streaming SDK turns — same root as 01.14.
- Slice 04: `relay-translate.ts:193-195` shares 01.16's observer — the settle fix lands in `chain-relay.ts`, but translate-side truncation (translator emits no terminator) should also surface.
