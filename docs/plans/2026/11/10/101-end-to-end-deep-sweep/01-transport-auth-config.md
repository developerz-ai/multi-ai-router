# 01 — Transport, auth, config, boot wiring

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/{routes,middleware,composition,config,errors,logging,observability,bin}/`, `apps/api/src/{app,main,types}.ts`, `apps/api/src/services/{admin-auth,admin,keys,crypto,pools,settings,shutdown}/`, `apps/api/src/services/dataplane/auth/`, `packages/core/`.

## Findings
(ranked: non-negotiable violations first, then critical → low)

### 01.1 high — Unknown-key spray evicts verified keys and puts Postgres on every request's path
- **Kind:** nn-violation (NN 8) — confirmed by throwaway script against `createRouterKeyVerifier`
- **Where:** `apps/api/src/services/dataplane/auth/verifier.ts:85-89` (one `TtlCache` for both outcomes), `:95-109` (`remember`), `:141-143` (in-flight bound = `maxEntries`), `apps/api/src/services/dataplane/auth/cache.ts:52-56`
- **Defect:** negative entries share the LRU with verified keys, and the only bound on concurrent miss loads is the cache size (4096), so unauthenticated well-formed-but-unknown keys both evict warm keys and queue unbounded `findUsableByPrefix` queries on the main pool.
- **Failure scenario:** no credential needed. Send `mar_live_<32 random>` at ~1k rps. Each is one main-pool query (pool default 10). Every 4096 distinct bad keys push out any verified key not used inside that window; `KEY_CACHE_NEGATIVE_TTL_SECONDS=0` still inserts (and evicts) an already-expired entry. Legit requests then miss, and their 1–3 queries wait behind up to 4096 attacker loads → auth latency goes from a map hit to pool-queue time; `router_overhead_seconds` blows the 5 ms budget. Reproduced at `maxEntries: 64`: 64 bad keys → the good key re-queried the DB.
- **Fix:** (1) two caches in `verifier.ts`: verified (`KEY_CACHE_MAX`) and negative (own bound, new `KEY_CACHE_NEGATIVE_MAX`), so a negative can never evict a positive; skip the insert entirely when negative TTL is 0. (2) Separate the in-flight ceiling from cache size: new `KEY_VERIFY_MAX_PENDING` (default well under `DB_POOL_MAX`-scaled, e.g. 32); beyond it `KeyVerificationUnavailableError` as today (`:142`). (3) Add env fields in `config/env-schema.ts` + `env-reader.ts`, wire in `composition/request-services.ts:45-56`. Update `docs/idea/04-api-keys-and-access.md` (verification path) and `09-deployment.md` env table.
- **Test:** unit, `verifier.test.ts`: warm one key, verify `maxEntries` distinct unknown keys, assert the warm key verifies with zero further repository calls; assert pending loads above the new ceiling get `503` while a cached key still verifies.

### 01.2 high — Admin sessions cannot be revoked: password rotation, password removal and allowlist removal all leave live sessions for up to 30 days
- **Kind:** bug (security)
- **Where:** `apps/api/src/services/admin-auth/localCredential.ts:96-105` (`set`/`remove` touch only the credential row), `apps/api/src/bin/admin.ts:114-156`, `apps/api/src/services/admin-auth/service.ts:221-254` (`authenticate` checks signature + expiry only), `composition/runtime-telemetry.ts:64-69` (durable Postgres store)
- **Defect:** nothing ends an existing session except its own logout or expiry (`ADMIN_SESSION_IDLE_MINUTES` 43200 / `ADMIN_SESSION_ABSOLUTE_HOURS` 720), and the documented remedy (restart) stopped working when sessions moved to Postgres.
- **Failure scenario:** local password leaks; attacker signs in. Operator runs `bin/admin set-password` and restarts per `docs/idea/07-security.md:358`. Attacker's cookie still authenticates (row in `admin_sessions`, signing key unchanged) and can `POST /api/admin/keys/:id/reveal` for 30 days. Same for an operator removed from `ADMIN_OIDC_ADMIN_EMAIL`: session survives the redeploy.
- **Fix:** (1) `AdminSessionRepository.deleteByUsername` / `deleteAll` (db slice owns the SQL). (2) `bin/admin set-password` and `delete-password` delete `local-admin` sessions in the same run; add `bin/admin revoke-sessions [--user <email>]`. (3) In `authenticate` (`service.ts:229-237`), reject a session whose `username` is neither `LOCAL_ADMIN_USERNAME` with a configured local credential nor in the current `adminEmails` when an allowlist is set — in-memory check, no query. Running replicas pick the delete up within `ADMIN_SESSION_REVALIDATE_SECONDS`. Fix `docs/idea/07-security.md:358` and `13-admin-oidc.md`.
- **Test:** integration: login, `set-password` path deletes sessions, next request `401`; unit: session for an email dropped from the allowlist is refused.

### 01.3 medium — Unauthenticated requests write unbounded audit rows and reach Postgres before any throttle
- **Kind:** bug / db
- **Where:** `services/admin-auth/service.ts:183-189` (audit row for every *throttled* local attempt), `:141-158` (audit row per failed OIDC callback, no throttle on the callback at all), `routes/admin/auth.ts:71,110,122` (`methods()` → `repository.get()` per hit, and before the throttle check on `/oidc/start`), `routes/health.ts:34` (`/readyz` → `select 1` per hit, no single-flight)
- **Defect:** the login throttle bounds argon2 work but not database writes; a refused attempt still costs an `audit_events` insert kept `RETENTION_AUDIT_DAYS` (365).
- **Failure scenario:** `while true; curl -XPOST /api/admin/auth/login -d '{"password":"x"}'` after lockout → one insert per request, forever. `GET /api/admin/auth/oidc/callback?code=a&state=b` → one `oauth_states` consume + one audit insert per request, never throttled. The audit feed's newest 200 rows become `admin.login_failed`, which with 01.10 hides real events. All of it shares the 10-connection main pool with admin reads and sweeps.
- **Fix:** audit the lockout transition once per bucket (when `check` first denies), not every denied request — return a `firstDenial` flag from `throttle.ts:54-73`. Apply the per-IP throttle to `/oidc/callback` before `stateStore.consume`. Cache `local.isConfigured()` with a short config TTL (reuse `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS` or a new field) so `/methods` and the two OIDC routes stop querying per hit. Single-flight the `/readyz` database probe (health slice owns `services/health/databaseProbe.ts`). Update `docs/idea/13-admin-oidc.md:199`.
- **Test:** unit on `service.ts`: 1000 throttled attempts → 1 audit record; integration: 50 bogus callbacks from one IP → `429` after `ADMIN_LOGIN_MAX_ATTEMPTS`, audit row count bounded.

### 01.4 medium — `TRUST_PROXY` takes the leftmost `X-Forwarded-For`, which the documented nginx config lets the client choose
- **Kind:** bug (security)
- **Where:** `apps/api/src/routes/admin/auth.ts:285-289`; `docs/idea/09-deployment.md:353`
- **Defect:** the throttle and audit IP is `split(",")[0]`; behind an appending proxy (`$proxy_add_x_forwarded_for`, the shipped example) that element is whatever the client sent.
- **Failure scenario:** `TRUST_PROXY=true` behind the documented nginx. Attacker sends `X-Forwarded-For: <random>` per attempt → nginx forwards `<random>, <real>` → a fresh throttle bucket each time; the lockout never fires and audit rows carry forged addresses. Only `ADMIN_LOGIN_MAX_CONCURRENT` still bounds the grind.
- **Fix:** take the entry `TRUST_PROXY_HOPS` (new env, default 1) from the right; fall back to the socket address when the header has fewer entries. Change the nginx example only if a single-hop overwrite (`$remote_addr`) is preferred. Docs: `09-deployment.md:192,353`, `07-security.md:145`, `04-api-keys-and-access.md:126`.
- **Test:** unit on an extracted `clientIp(headers, socket, hops)`: `"evil, 203.0.113.9"` with hops 1 → `203.0.113.9`.

### 01.5 medium — No `unhandledRejection` / `uncaughtException` handler: one stray rejection kills the process with no drain and an unredacted stderr line
- **Kind:** bug — runtime behaviour confirmed on Bun 1.4.4; no in-repo rejection source identified
- **Where:** `apps/api/src/main.ts:123-139` (only SIGTERM/SIGINT are handled, via `services/shutdown/transport.ts:78`)
- **Defect:** Bun exits 1 immediately on an unhandled rejection, printing the raw error; the router installs nothing, so behaviour also differs by whether `SENTRY_DSN` is set (Sentry's integration registers its own handler).
- **Failure scenario:** any fire-and-forget promise that rejects (there are many `void x()` sites across slices) → every in-flight stream cut, no `http-drain`, no usage flush, and the message bypasses `logging/redact.ts` (a throwaway script printed a `postgres://user:pass@…` message verbatim).
- **Fix:** in `main.ts`, register both handlers before `migrate`: log through the redacting logger (`error: reason`), `captureException`, and for `uncaughtException` run the same `runShutdownPhases` path with exit 1; for `unhandledRejection` log + capture and keep serving. Document in `docs/idea/08-observability.md` (near `:1285`).
- **Test:** unit on an extracted `installCrashHandlers(signals, logger)` with a fake emitter: rejection carrying a DSN produces one redacted log line and no exit.

### 01.6 medium — Admin session store fences on one global generation: any logout or purge sweep can 401 an unrelated operator
- **Kind:** bug (race)
- **Where:** `apps/api/src/services/admin-auth/postgresSessionStore.ts:70-72` (`get`), `:90-95` (`touch`), `:102,110,118` (every delete and every `deleteExpired` bumps `generation`)
- **Defect:** a read or touch in flight across *any* generation bump returns "no session", though the fence only needs to cover the id being deleted.
- **Failure scenario:** operator A's cache entry is past `ADMIN_SESSION_REVALIDATE_SECONDS`; A's request awaits `repository.find`. Operator B logs out, or the `admin_session_purge` task calls `deleteExpired`, in that window → `get` returns `undefined` → `AdminAuthError` `401` → the SPA drops A to the login page with a valid session. The key verifier already fixed the same shape with a bounded retry (`verifier.ts:147-152`); this store did not.
- **Fix:** replace the global counter with a per-id tombstone: `get`/`touch` re-check only `deletions.has(id)` (and a per-id epoch for the delete-completed case); `deleteExpired` evicts expired cache entries without a fence — an expired row is already refused by `service.ts:233`.
- **Test:** unit: hold `repository.find` for session A, call `delete(B)` and `deleteExpired`, release → A still authenticates; `delete(A)` during the hold → `undefined`.

### 01.7 medium — Client-chosen `model` is a metric label; at 4096 series the metric silently stops counting new keys and models until restart
- **Kind:** bug / memory
- **Where:** `apps/api/src/observability/metrics.ts:157-162` (`sample.model`, set from the request body at `services/dataplane/orchestrator.ts:148-149` before any catalog check), `observability/registry.ts:111-117`, `registry.ts:64` (cap is a constant, not wired from env in `observability/runtime.ts:65-76`)
- **Defect:** any authenticated caller mints a series per distinct model string (truncated to 64 chars), and the bounded registry answers by permanently dropping every *later* legitimate series for that metric, warning once.
- **Failure scenario:** a client typo loop or a hostile key sends 4096 distinct `model` values → `router_requests_total` and `router_request_duration_seconds` are full; a key minted afterwards never appears in either; dashboards and alerts built on them read zero. One `metric stopped adding series` line is the only signal.
- **Fix:** label with the requested model only when it resolved against the routing catalog, else `"other"` (decide in `observeRequest` from a `sample.modelKnown` flag the dataplane slice sets). Make the cap `METRICS_MAX_SERIES_PER_METRIC` in `config/env-schema.ts` and pass it at `runtime.ts:65`. Expose `router_metric_series_dropped_total{metric}` instead of a once-only log. Docs: `08-observability.md:930`.
- **Test:** unit on `createMetrics`: 5000 unknown models then one new key with a known model → that key's series exists.

### 01.8 medium — Every key's cache expiry sends one request through 1–3 Postgres queries; scoped keys are never "one indexed query"
- **Kind:** perf
- **Where:** `apps/api/src/services/dataplane/auth/verifier.ts:130-138,151,162`, `auth/scope.ts:50-58`
- **Defect:** entries hard-expire at `KEY_CACHE_TTL_SECONDS`; the next request for that key awaits `findUsableByPrefix` and, for `pools`/`accounts` scope, two more membership queries, all on the main pool the sweeps share.
- **Failure scenario:** 200 active keys, TTL 60 s → ~3.3 requests/s pay a DB round trip (plus pool wait during a rollup or janitor sweep) before the body is read; that is the p99 tail of `router_overhead_seconds`. Invalidation on edit/revoke already covers freshness on the serving replica; the TTL only serves other replicas.
- **Fix:** refresh-ahead: on a hit past e.g. 80 % of TTL, return the cached key and start one background reload (reuse `inFlight`, same generation fence); hard-expire only at TTL when no refresh landed. Collapse the scope load into the prefix query (one repository method returning row + targets — db slice). Doc: `04-api-keys-and-access.md` verification path.
- **Test:** unit with injected clock: hit at 0.9×TTL returns synchronously-resolved cached key and triggers exactly one repository call; a revoke during the refresh is not re-cached.

### 01.9 low — OIDC start throttle counts every start as a failure and is never reset; IPv6 keys are per /128; a full map costs O(n) per request
- **Kind:** bug
- **Where:** `services/admin-auth/service.ts:102-107` (no `oidcThrottle.reset` in `completeLogin` `:160-168`), `services/admin-auth/throttle.ts:32-34,47-62`
- **Defect:** five sign-in clicks from one address inside 15 minutes lock OIDC for 15 more, successful or not; a /64 holder gets unlimited buckets; once `ADMIN_LOGIN_MAX_TRACKED_IPS` is reached every request scans all 10 000 buckets and every untracked address is refused.
- **Failure scenario:** team behind one NAT without `TRUST_PROXY` (or with 01.4 unfixed): the sixth operator sign-in of the quarter-hour gets `429`. Separately, 10 000 `GET /oidc/start` from distinct IPv6 addresses → all new addresses locked out for the window.
- **Fix:** reset the OIDC bucket on a completed login; key IPv6 by /64; evict at most once per N ms rather than per call.
- **Test:** unit in `throttle.test.ts` and `service.test.ts` for each of the three.

### 01.10 low — Audit `kind` filter is applied after `LIMIT 200`
- **Kind:** bug / db
- **Where:** `apps/api/src/services/settings/service.ts:178-191`
- **Defect:** a kind is filtered in memory over the newest 200 rows, so older events of that kind are unreachable.
- **Failure scenario:** `GET /api/admin/audit?kind=key.revealed` returns `[]` after 200 newer `admin.login_failed` rows (see 01.3), though reveals exist.
- **Fix:** add `kind` to the repository predicates (`AuditRepository.list`/`listForSubject`, db slice; needs an index on `(kind, created_at)`), drop the widened scan.
- **Test:** integration: 250 rows of kind A after 1 row of kind B → `?kind=B` returns it.

### 01.11 low — Admin read paths: N+1 on the tasks screen, quadratic grouping on keys and pools, full account rows loaded to label pool members
- **Kind:** db / perf
- **Where:** `services/settings/service.ts:157-173` (2 queries × every scheduled task per load), `services/keys/service.ts:58-67` (`flatMap` over all targets per key), `services/pools/view.ts:43-45` (same per pool), `services/pools/service.ts:66-70` (`accounts.list()` — every column, ciphertext included — for one pool)
- **Defect:** per-row follow-ups and repeated full scans where one grouped query / one `Map` fits.
- **Failure scenario:** ~15 tasks → 30 concurrent queries on a 10-connection pool every settings refresh; 500 keys × 2000 targets → 10⁶ comparisons per keys list.
- **Fix:** one `lastRunAndSuccessPerTask()` repository query; group targets/members into a `Map` once before mapping; a label-only account projection (db slice).
- **Test:** unit: repository stub asserts one call for the tasks screen.

### 01.12 low — Completion log line costs ~18 µs of synchronous regex work before the response is released
- **Kind:** perf — measured (20 000 lines through `createLogger`, realistic fields)
- **Where:** `apps/api/src/middleware/logger.ts:82-88`, `logging/logger.ts:39-48`, `logging/redact.ts:206-211,228-238`
- **Defect:** every string field, bound ones included, runs 18 value regexes plus a normalizing regex per field name on every line; the line is emitted after `await next()`, i.e. before Hono hands the response back.
- **Failure scenario:** ~12 string fields per `request completed` line → ~200 regex scans per request on the event loop; small against 5 ms, but it is on the time-to-headers path of every request.
- **Fix:** redact bound fields once in `child()`; memoize `isSecretFieldName` per name; emit the completion line from a `queueMicrotask`/after-response hook so it is off the header path.
- **Test:** unit: `child()` output is redacted identically; bench assertion stays in `bin/bench`.

### 01.13 low — Shutdown and boot failures discard their reason
- **Kind:** bug (swallowed failure)
- **Where:** `services/shutdown/run-phases.ts:13-20`, `composition/lifecycle.ts:35-45`, `main.ts:132-137`, `services/shutdown/transport.ts:89-94`; `main.ts:257-275`
- **Defect:** a failed phase logs its name and `errorClass` only; a failed migration logs then `process.exit(1)` with no `captureException`/flush, contradicting the comment at `main.ts:35-37`.
- **Failure scenario:** `usage-writer` stop rejects during a deploy → log says `runtime shutdown step failed {step}` and nothing else. Migration failure never reaches GlitchTip.
- **Fix:** pass the rejection to the reporters and log `error: reason` (the logger redacts); `captureException` + `Sentry.flush` (bounded) before the boot exits.
- **Test:** unit on `runShutdownPhases` / `createRuntimeLifecycle`: reporter receives the error.

### 01.14 low — Hard-coded lifetimes and limits (NN 11)
- **Kind:** nn-violation (NN 11)
- **Where:** `services/admin-auth/oidc/jwks.ts:115-116` (JWKS TTL 1 h / 5 min floor), `services/admin-auth/oidc/flow.ts:116-117` (discovery document cached forever — an IdP endpoint change needs a restart; no exit), `observability/registry.ts:64` (see 01.7), `services/dataplane/auth/verifier.ts:79` and `:142,173` (`MAX_LOAD_ATTEMPTS`, `retryAfterSeconds: 1`), `observability/metrics.ts:49` (`MAX_PENDING_HOPS`)
- **Defect:** TTLs/limits as constants.
- **Failure scenario:** IdP rotates `token_endpoint`; sign-in fails until the router is restarted.
- **Fix:** `ADMIN_OIDC_DISCOVERY_TTL_SECONDS`, `ADMIN_OIDC_JWKS_TTL_SECONDS` in the env schema; re-discover on TTL or on a token-endpoint failure. Others ride 01.1/01.7.
- **Test:** unit with injected clock: discovery refetched after TTL.

### 01.15 low — Dead and duplicated code; oversized files
- **Kind:** structure
- **Where:** `services/admin-auth/oidc/discovery.ts:46-145` (`createDiscoveryService`, `defaultDiscoveryFetch` — no production caller; `flow.ts:116-157` reimplements it), `oidc/state.ts:116-118` (`ipThrottleNamespace` unused), `oidc/flow.ts:227` (unreachable `createJWKSCache` fallback), `routes/admin/oauth-callback.ts:46-77` vs `routes/admin/auth-callback-page.ts:12-69` (same page + `escapeHtml` twice), body-cap default literal in `app.ts:128-129`, `config/listen.ts:24-26`, `config/admin-bodies.ts:12-13`, `services/admin/parse.ts:17` and nine `?? 1048576` route sites, `composition/admin.ts` (455 lines) and `config/env-reader.ts` (310) over the 300 LOC rule
- **Defect:** two discovery implementations to keep in sync; defaults that can drift.
- **Fix:** make `flow.ts` use `createDiscoveryService` (or delete it); delete the unused exports; one shared callback-page helper; make `maximumJsonBytes` required on route deps and keep the default in `config/admin-bodies.ts` only; split `composition/admin.ts` by account/auth/settings wiring.
- **Test:** existing suites; `bun run typecheck`.

## Checked, not a bug
- Cross-replica key revocation lag is documented and bounded (`docs/idea/07-security.md:438`, `04-api-keys-and-access.md:247`); `verifier.invalidate` fences in-flight loads (`verifier.ts:147-167`).
- Router key: shape-checked before any query (`packages/core/src/ids.ts:62-65`), SHA-256 cache key, decrypt + `timingSafeEqual` over digests on miss only (`verifier.ts:110-123`, `constantTime.ts:11`). No per-hit crypto beyond one hash.
- Key cache TTLs/size are env (`composition/request-services.ts:49-53`); session cache size/revalidate are env (`runtime-telemetry.ts:67-68`).
- OIDC: state/nonce/PKCE one-shot, encrypted at rest, TTL from `RETENTION_OAUTH_STATE_MINUTES` (`oidc/state.ts:77-112`); `iss`/`aud`/`azp`/`iat`/`exp`/nonce/alg checked (`oidc/idToken.ts:133-207`); issuer pinned in discovery (`flow.ts:137`). State is not bound to the browser, but a callback only succeeds for an allowlisted principal, so login-CSRF yields nothing.
- No open redirect: `/oidc/start` redirects only to the discovered `authorization_endpoint`; callback page navigates to the literal `/` (`auth-callback-page.ts:58`).
- CSRF: every guarded mutating method needs the header (`middleware/adminAuth.ts:83-85`); bearer `ADMIN_API_TOKEN` path skips it by design (not ambient). Router keys are refused on the admin plane before anything else (`adminAuth.ts:70-72`).
- Local-login throttle records before the argon2 await and caps concurrency (`service.ts:183-202`) — prior 02.4 is fixed.
- Error rendering: non-`RouterError` → fixed `Internal server error`; every message passes `redactValue` (`errors/render.ts:103,184-189`); account ids leave only as `acct_<hash>` (`errors/account-ref.ts`).
- Request log is a header allowlist with a 200-char cap (`middleware/logger.ts:27-59`); `path` excludes the query string. Sentry events go through `redact` at depth 8 with every auto-collection off (`observability/sentry.ts:50-112`).
- Admin JSON bodies are size-capped while streaming (`services/admin/bounded-json.ts`); `maxRequestBodySize` is the max of the configured caps (`config/listen.ts:23-27`).
- Migration failure exits before the listener opens; `runtime.start()` failure stops what it started and rejects (`composition/lifecycle.ts:56-73`).
- SPA fallback cannot answer API prefixes (`routes/spa.ts:35,131-137`); NUL/overlong paths fall through to the shell.
- `holdIdleClock` wraps only non-SSE bodies; SSE is returned untouched (`middleware/idleClock.ts:35-43`). **Coordinator note:** this is true of the code as read, but prod shows the hold not taking effect on anthropic→zai non-stream passthrough (12.1: 512 cuts at 58–70 s in 14 d, Envoy `502 UPE` on matching request ids). Treat the idle clock as an open defect owned here; reproduce per 12.1 before touching it.

## Doc claims falsified
- `docs/idea/07-security.md:358` says restarting invalidates admin sessions; sessions are rows in Postgres read by `postgresSessionStore.ts:71` and survive restarts (01.2).
- `docs/idea/09-deployment.md:353` ships `proxy_add_x_forwarded_for` as the proxy config for `TRUST_PROXY=true`; `routes/admin/auth.ts:287` trusts the leftmost entry, which that config leaves client-controlled (01.4).
- `apps/api/src/main.ts:35-37` (comment) says a failed migration is what GlitchTip should see; `main.ts:264-274` exits without capturing (01.13).
- `services/dataplane/auth/verifier.ts:13-16` / `middleware/routerKeyAuth.ts:16-18` say a miss costs one indexed lookup; a scoped key costs three queries (`auth/scope.ts:50-58`) (01.8).
- `docs/idea/13-admin-oidc.md:199` reads `reason: "throttled"` rows as the lockout "doing its job"; each is an unbounded unauthenticated write (01.3).

## Steps
1. Verifier: split negative cache, separate pending ceiling, refresh-ahead (01.1, 01.8) + env fields + docs. One commit.
2. Session revocation: repository deletes (db slice), `bin/admin` verbs, allowlist re-check in `authenticate`, per-id fence in the Postgres store (01.2, 01.6) + docs.
3. Login surface: audit-once-per-lockout, callback throttle, `isConfigured` cache, right-most XFF with hop count, OIDC throttle reset, IPv6 /64 (01.3, 01.4, 01.9) + docs.
4. Crash handlers and failure reasons in `main.ts` / shutdown (01.5, 01.13).
5. Metrics: known-model label, configurable cap, dropped-series counter (01.7).
6. Audit kind predicate, tasks query, grouping maps (01.10, 01.11) — coordinate repository changes with the db slice.
7. OIDC discovery/JWKS TTL env, dead-code removal, default dedup, file splits (01.14, 01.15); logger bound-field pre-redaction (01.12).
8. `CHANGELOG.md` + version per house rule.

## Tests
- Extend: `apps/api/src/services/dataplane/auth/verifier.test.ts`, `services/admin-auth/{service,throttle,postgresSessionStore}.test.ts`, `services/admin-auth/oidc/flow.test.ts`, `observability/metrics.test.ts`, `services/settings/service.test.ts`, `services/shutdown/run-phases.test.ts`, `logging/logger.test.ts`, `routes/admin/auth.test.ts` (client IP).
- Add: crash-handler unit test beside `main.ts`'s extracted helper.
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end.

## Done when
- 4096+ unknown keys leave a warm key answering with zero repository calls, and pending loads are capped by their own setting.
- `bin/admin set-password` / `delete-password` / `revoke-sessions` end the affected sessions; a de-allowlisted email's session is refused; an unrelated logout or purge never 401s another session.
- Throttled or bogus sign-in traffic produces a bounded number of audit rows and no per-request query on `/methods`.
- A forged leftmost `X-Forwarded-For` lands in the real client's bucket.
- An unhandled rejection produces one redacted JSON log line and no silent exit.
- A new key's `router_requests_total` series appears after 5000 unknown-model requests.
- The five doc lines above match the code.

## Not covered
- Dockerfile, compose, `bin/` scripts, workflows — reassigned to auditor 11 mid-task; nothing read.
- Read by signature only, not line by line: `composition/{recovery,cli-resources,background-admission,credential-ownership,usage-reports,runtime-scheduler,runtime-repositories}.ts`, `config/{usage-report,claude-login,cli-ownership,upstream-stream,metric-inventory,env-*-types}.ts`, `services/pools/{mutations,validation,schemas}.ts`, `services/settings/{schema,audit,tasks}.ts`, `packages/core/src/{domain/*,wall,errors}.ts`, `types.ts`.
- Test files were not skimmed for wrong-rule encodings.
- 01.5: no concrete rejecting call site was traced; the finding is the missing handler plus the verified Bun exit behaviour.
- 01.8 and 01.12 costs: 01.12 measured in isolation; 01.8 reasoned, not benchmarked against a real pool.
- Whether `sample.model` can be attacker-varied without limit depends on `admitRoutingModel`'s length/charset rules (dataplane slice); only the 64-char label truncation was confirmed.
