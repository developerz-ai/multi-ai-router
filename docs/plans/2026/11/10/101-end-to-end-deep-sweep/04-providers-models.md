# 04 — Provider drivers (non-Claude-sub) + model catalog

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/providers/*.ts`, `apps/api/src/providers/{drivers,failure,rate-limit}/`, `apps/api/src/services/{models,catalog}/`.

Paths below are relative to `apps/api/src/` unless they start with `docs/` or `packages/`.

## Findings

### 04.1 high — Wording rules read echoed client text as a dead balance; one request parks a healthy account `exhausted`
- **Kind:** nn-violation (7: a wall read from words, misread park) / bug
- **Where:** `providers/failure/classify.ts:192` (`messageRule` has no status/type/anchor guard); `providers/drivers/anthropic-api.ts:32,38`; `kimi.ts:35,156,176`; `deepseek.ts:35,40`; `zai.ts:49,133`; `opencode-go.ts:45,78`; `opencode-oauth.ts:116`; `openrouter.ts:19,129`; `compatible-rules.ts:46-63` (`genericCreditsRule` fires on any 4xx incl. 400/404 — used by groq, xai, mistral, together, cerebras, ollama, `openai-compatible`, `anthropic-compatible`).
- **Defect:** credit/limit verdicts are unanchored substring matches over the whole upstream message on any status, and upstream 4xx messages echo client-controlled text (model name, block `type`, field names); model name is only length-capped (`services/dataplane/body/scanner-types.ts:10`, 256 bytes).
- **Failure scenario:** confirmed with the real drivers in a scratch script: `anthropic-api` `404 {"error":{"type":"not_found_error","message":"model: credit balance is too low"}}` → `credits-exhausted (anthropic:credit-balance-too-low)`; same for a `400` `Input tag 'credit balance is too low' …`; `kimi` `403 "You do not have access to model insufficient balance"` → `credits-exhausted`; `kimi` `404 "model reached your usage limit not found"` → `rate-limited` + 15 min estimate; `groq`/`xai`/`openai-compatible` `404 "The model \`insufficient balance\` does not exist"` → `credits-exhausted (compatible:out-of-credits-wording)`; `deepseek`/`zai` likewise on a `400`. `routing/breaker.ts:147` moves the account to `exhausted` on the first such failure; `credits-exhausted` is retryable (`classify.ts:67`), so the chain offers the same request to the next account and parks it too. Any router-key holder (or an agent with a garbage model string) takes a whole pool of undeclared-`supportedModels` accounts out for ≥ `EXHAUSTED_RECHECK_FIRST_MINUTES`, with a red banner and `402`s. Upstream echo wording is `unverified` per vendor (Anthropic's `model: <name>` and the Kimi sentence in `kimi.ts:53` are documented shapes); the classifier behaviour is verified.
- **Fix:** make the guard part of the mechanism, not each driver: (1) `messageRule` (`classify.ts:192`) takes required `statuses` and optional `types`, and an optional `anchor: "start"`; (2) anthropic: status `400` + type `invalid_request_error` + `^Your credit balance is too low`; kimi balance: exclude `404` and require type ≠ `not_found_error`/`permission_error "…access to model"`; deepseek: statuses `[402, 400]` + start anchor on the published phrase; zai: drop bare `account balance`, keep codes `1113/1112` as the verdict and wording only on non-404; `genericCreditsRule`: skip `404` and any body whose `code`/`type` names a model-not-found (`model_not_found`, `not_found_error`, `NotFoundError`); (3) before any wording test, strip quoted/backticked spans from the message (`'…'`, `"…"`, `` `…` ``) — echoed values are always quoted or follow `model:`. Update `docs/idea/03-providers.md` failure table and `05-routing-and-failover.md`.
- **Test:** unit, `test/unit/providers/failure-vendors.test.ts` + `failure-anthropic-openai.test.ts`: each echo body above → not `credits-exhausted`/`rate-limited` (failure case first), genuine bodies still classify. Integration: mocked upstream answers `404 model: credit balance is too low`; assert account stays `active`, `UsageRecord` is `client_error`.

### 04.2 medium — Provider-reported resets are uncapped everywhere except epoch-seconds; a bogus header parks an account for years
- **Kind:** bug
- **Where:** `providers/rate-limit/parse.ts:138-155` (`retry-after`), `:74` + `duration.ts:59` (epoch millis, no ceiling), `duration.ts:21` (durations), `drivers/openai-oauth-quota.ts:203` (`resets_in_seconds`), `drivers/zai.ts` `parseZaiReset`, `drivers/gemini.ts` `retryDelaySeconds`; consumer `services/routing/backoff.ts:30` → `packages/core/src/reset-deadline.ts:5` (only bound: `8.64e15`).
- **Defect:** `duration.ts:80` caps an inferred epoch-seconds reset at 7 days because "`9999999999` is 2286 — a misread, not a window", but every other reset form is trusted verbatim and labelled `provider-reported`.
- **Failure scenario:** scratch-verified: `retry-after: 315360000` → `retryAfterSeconds 315360000`; `x-ratelimit-reset: 9999999999999` + `remaining: 0` → `resetsAt 2286-11-20`; `x-ratelimit-reset-requests: 87600h` → 10 years. `breaker.ts:209` sets `cooldownUntil` to it; a later shorter reading never shortens it (`breaker.ts:226`). A gateway bug or a unit change (ms vs s) removes the account from rotation until an operator notices. Also `parse.ts:149` uses `Number()`: `retry-after: 0x10` → 16 s, `1e9` → 31 years.
- **Fix:** one ceiling, config not constant (NN11): `ROUTING_MAX_REPORTED_RESET_SECONDS` (default 8 days — longest documented window is weekly; `compatible-body.ts:27` keeps its own 31 d for the monthly fixture). Apply once in `reportedReset` (`services/routing/backoff.ts:30`, routing slice) so every transport is covered: past the ceiling → clamp and relabel `estimated`. In `parse.ts:149` accept only `/^\d+(\.\d+)?$/`. Fold `duration.ts:80` into the same knob. Doc: `docs/idea/05-routing-and-failover.md`.
- **Test:** unit `rate-limit.test.ts`: hex/exponent `retry-after` → absent; unit `routing/breaker` (injected clock): 10-year reset → cooldown ≤ ceiling, source `estimated`.

### 04.3 medium — Provider-name special case outside `providers/`: catalog sweep hard-codes `openrouter`
- **Kind:** nn-violation (12)
- **Where:** `services/models/refresh.ts:74`, `:131`.
- **Defect:** `account.provider === "openrouter"` decides sweep eligibility in a service; the next aggregator needs a second edit here.
- **Failure scenario:** adding/renaming an aggregator provider touches `services/models/refresh.ts` besides its driver; `docs/idea/03-providers.md:765` ("Routing, keys, pools, usage … need no changes") is false.
- **Fix:** declare on the driver: `ProviderDriver.catalogSweep?: "manual"` (`providers/types.ts`), set in `drivers/openrouter.ts`; `isRefreshable`/`skipReason` read `httpDriver(provider)?.catalogSweep` and emit `"<transport>:manual-listing"`. Same pattern for the cross-slice leaks below.
- **Test:** unit `test/unit/models/refresh.test.ts`: a stub driver flagged `manual` is skipped; no provider literal left (`grep` assertion in `registry.test.ts` style).

### 04.4 medium — Quadratic regex on upstream-controlled error text blocks the event loop (~0.76 s at the default cap)
- **Kind:** perf
- **Where:** `providers/drivers/kimi.ts:35` (`account.*not active`), evaluated by `kimi.ts:156` on every Kimi error body.
- **Defect:** unbounded `.*` after a literal that can repeat: each `account` start rescans to end of message.
- **Failure scenario:** measured: a 64 KB message of repeated `account ` (the `UPSTREAM_ERROR_MAX_BYTES` default, `services/dataplane/error-body.ts:3`) → 760 ms inside `RegExp.test`, 839 ms for the whole `classifyFailure`; cost is O(n²), so an operator raising the cap to 1 MB makes it minutes. Every in-flight stream on the replica stalls for that time. Trigger is an upstream/gateway HTML or echoed body.
- **Fix:** `account[^.]{0,80}not active` (the file's own bounded style); and in `classify.ts` cap the message handed to wording rules (first 2 KB — every provenance sentence is < 200 chars) so no future pattern can regress it.
- **Test:** unit `failure-vendors.test.ts`: 64 KB adversarial message classifies in < 20 ms (assert on a step budget, e.g. compare against 1 KB run ×100).

### 04.5 medium — Periodic warm-catalog refresh failures are swallowed with no log and no metric
- **Kind:** bug
- **Where:** `services/catalog/store.ts:72`, `services/models/store.ts:84`.
- **Defect:** `void refresh().catch(() => undefined)`; neither store has a logger, and `loadedAt()` is exported to no gauge (`observability/runtime.ts:112` exports only the price book's).
- **Failure scenario:** Postgres query starts failing (pool exhausted, a migration skew on `catalog_snapshot.read`): routing keeps serving the last snapshot indefinitely — an account another replica disabled, a deleted pool member, a rotated credential's ciphertext — and nothing in logs or `/metrics` says the snapshot is hours old. Violates "never swallow failures" and "every gate needs an exit … visible".
- **Fix:** add `onRefreshError?: (error: unknown) => void` to both deps (wired in `composition/warm-state.ts:91,131` to `logger.warn` + Sentry), and gauges `routing_catalog_loaded_at_seconds` / `model_catalog_loaded_at_seconds`. Lift the duplicated timer loop + `defaultJitter` (identical in both stores; the price book has a third copy per the store comment) into `services/snapshots/` as `createJitteredRefreshTimer`.
- **Test:** unit `test/unit/catalog/refresh-barriers.test.ts`: failing `load` on a tick → `onRefreshError` called once, snapshot unchanged, next tick retries.

### 04.6 low — Listing and plan-quota success bodies are read unbounded
- **Kind:** memory
- **Where:** `services/models/listing.ts:288`, `services/models/plan-quota.ts:103` (`response.json()`).
- **Defect:** error bodies are capped (`readErrorBody`), success bodies of these two background GETs are not; only the attempt timeout bounds them.
- **Failure scenario:** an `openai-compatible`/`ollama` account whose `/models` (operator-typed base URL, proxy, captive portal) streams a multi-hundred-MB body within `UPSTREAM_TIMEOUT_MS` → whole body buffered then parsed, hourly, per such account.
- **Fix:** shared `readJsonCapped(response, maxBytes)` next to `readErrorBody` (dataplane slice) with a config cap (`MODEL_LISTING_MAX_BYTES`, default 8 MB — OpenRouter's listing is ~1 MB); over cap → `discovery_unreadable` / `quota:unreadable`. Also act on `has_more` (`listing.ts:126` parses it and nothing reads it): `true` → log + `detail: "listing truncated at 1000"`.
- **Test:** unit `test/unit/models/listing.test.ts`: stub fetch streaming past the cap → `ok: false, code: "discovery_unreadable"`, reader cancelled.

### 04.7 low — `GET /v1/models` rebuilds constant tables per account per request
- **Kind:** perf
- **Where:** `services/models/listable.ts:65` (`shippedSubscriptionModels()`), `:66-67` (two `rowLookup` Maps), `services/models/store.ts:93` (`modelsOf` spreads a new array); caller `services/dataplane/models.ts:90,149`.
- **Defect:** for every in-scope subscription account: ~35 shipped rows rebuilt through `lookupContextWindow`/`modelLookupKeys`, concatenated, indexed twice, `resolveModel` up to 3× per name; `/v1/models/:id` builds the whole list to `.find` one id.
- **Failure scenario:** 20 subscriptions × (60 catalog + 35 shipped rows) → ~4 000 row objects, 40 Maps, ~2 000 `resolveModel` calls per listing request; Claude Code hits this endpoint at every start.
- **Fix:** hoist `shippedSubscriptionModels()` to a frozen module constant; build one lookup carrying both size and reasoning; store `modelsOf` arrays at `index()` time; memoize `listableModels` in a `WeakMap<AccountSnapshot, …>` keyed additionally on the catalog-rows array identity (both are replaced wholesale on refresh).
- **Test:** unit `test/unit/models/` new `listable.test.ts`: same inputs → same array identity; a refreshed snapshot → recomputed.

### 04.8 low — Status defaults make transient 4xx non-retryable and `529` a breaker strike
- **Kind:** bug
- **Where:** `providers/failure/classify.ts:89-97`; special-cased once at `drivers/openrouter.ts:127`.
- **Defect:** `408`, `425`, `421` fall to `invalid-request` (no failover, upstream error relayed); a `529` whose body is unreadable/truncated is `server-error` (strikes the account) because `overloaded` is only reachable via `error.type` (`anthropic-api.ts:42`).
- **Failure scenario:** any vendor/gateway `408 Request Timeout` → chain stops with healthy accounts in scope; OpenRouter needed its own rule for it (the symptom fixed where it surfaced). Anthropic `529` behind a proxy that rewrites the body → three in a row cool a healthy key.
- **Fix:** `verdictForStatus`: `408`/`425` → `server-error`, `529` → `overloaded`; delete the OpenRouter `408` rule. Doc: status table in `docs/idea/05-routing-and-failover.md`.
- **Test:** unit `failure-anthropic-openai.test.ts`: bare `408` → retryable; bare `529` → `overloaded`.

### 04.9 low — Re-test cadences and reset bounds are constants in driver code
- **Kind:** nn-violation (11)
- **Where:** `drivers/kimi.ts:140-141`, `drivers/openrouter.ts:44`, `rate-limit/duration.ts:80`, `rate-limit/compatible-body.ts:27`.
- **Defect:** how long a spent Kimi/OpenRouter window is assumed to last (15 min / 60 min) is an interval the operator cannot tune; each carries provenance, so this looks deliberate — needs an owner ruling rather than a silent change.
- **Failure scenario:** a Kimi weekly limit is re-tested hourly for up to 7 days when the quota read (`kimi-quota.ts`) is unavailable (account with a `baseUrl` override → `url()` returns `null`); operator cannot stretch it.
- **Fix:** keep the driver value as the default; let `BreakerOptions` carry `estimatedResetFloorMs`/override (routing slice), or record the exemption for pinned provider estimates in `CLAUDE.md` NN11 / `docs/idea/03-providers.md`.
- **Test:** unit `provider-reset-regressions.test.ts`: override respected, `resetSource` stays `estimated`.

### 04.10 low — Structure: duplicated provider facts, generic `Error`, dead surface
- **Kind:** structure
- **Where:** `drivers/compatible-rules.ts:86` vs `rate-limit/compatible-body.ts:10` (same regex literal twice); `drivers/opencode-oauth.ts:17,109,115-117` re-declares `opencode-go.ts:25,32,44-46` (UA, session header, three failure patterns) with no provenance comment; `drivers/opencode-oauth.ts:121-123` throws generic `Error` and fakes `loopbackRedirectUri` because `ProviderOAuthFlow` (`types.ts:219`) requires `authorizeUrl`/`codeExchange` for a device-only issuer; `drivers/minimax.ts:94` inline `import("../types")`; `drivers/opencode-oauth.ts:94` reports `throttled: true` for a `5xx` (OpenAI's flow: `status === 429`, `openai-oauth-device.ts:99`); `providers/index.ts:216-237` re-exports ~20 `openai-oauth` constants no non-provider source imports.
- **Defect:** a drift in OpenCode's vocabulary must be fixed in two files; a device-only provider reached through the paste path surfaces a generic `500`-class error (`unverified`: whether `services/accounts/connect/` can call it).
- **Failure scenario:** OpenCode renames `FreeUsageLimitError` → one driver updated, the other cools seats as plain `429`s.
- **Fix:** move the shared OpenCode constants/rules into `opencode-failures.ts` (rename `opencode-shared.ts`) with provenance; export the body-reset regex once from `compatible-body.ts`; make `authorizeUrl`/`codeExchange` optional on `ProviderOAuthFlow` (or split `device`-only flow type) and delete `deviceOnly`; prune unused index exports.
- **Test:** existing `opencode-go.test.ts` / `opencode-oauth.test.ts` parameterised over both drivers for the shared rules.

## Checked, not a bug
- Model alias: exact, case-sensitive, own-property only (`providers/model-alias.ts:14`); case-insensitive keys in `services/models/store.ts:92` / `listable.ts:125` are describe-only, never sent upstream.
- Token/device/quota/listing responses are all Zod-parsed to `null` on reshape (`openai-oauth.ts:135`, `opencode-oauth.ts:25,46`, `openai-oauth-device.ts:45,63`, `*-quota.ts`, `listing.ts:103`, `opencode-models.ts:15`); no unvalidated cast found except `openai-oauth-stream-errors.ts:95` (`record()` narrow, fields type-checked after).
- `overloaded` never cools: `attempt-failure.ts` `attemptReading` clears `limited`; OpenCode `[prefill_cap_refused]`/`[overloaded]` matched before the `429` default (`opencode-failures.ts:13`).
- Year rollover / past reset in the compatible body reset: `compatible-body.ts:19-28` tries year and year+1, rejects normalised dates and > 31 d. Past `Retry-After` HTTP-date is dropped by `latestResetDeadline` (`packages/core/src/reset-deadline.ts:15`).
- z.ai `+08:00` stamp (`zai.ts`) — provenance cross-checked against `nextResetTime` in `zai-quota.ts` header comment.
- Prior 102/04.1 (durations never reaching the aggregate) is fixed: `parse.ts:156-171` `depletedReset`.
- Quota reads are advisory and `limited: false` in all four readers; credential never sent to an overridden base URL (`url()` → `null`).
- `404` unknown-model → `invalid-request` on vendors without a model-unsupported rule is deliberate (`ollama.ts:27-34`, `docs/idea/05`): operators declare `supportedModels`.
- Three touches to add a provider (`drivers/<id>.ts`, `ProviderId`, `registry.ts`) are an explicit ruling (`docs/idea/03-providers.md:777-791`); shipped data tables (`models/windows/index.ts:48`, `cost/prices.ts`) are keyed by id by the same design.
- Catalog sweep is serial with per-call timeout and durable attempt stamps (`scheduler/tasks/model-catalog-refresh.ts`, `select.ts`); no fan-out stampede. `createSnapshotRefresh` single-flights reads.
- Error bodies capped at `UPSTREAM_ERROR_MAX_BYTES` and redacted before classification (`dataplane/attempt.ts:245-254`); all other wording regexes are bounded (`[^.]{0,N}`) — flood inputs measured at 2–4 ms.
- Rate-limit header parse runs once per success, twice per error (headers-only then with body) — error path only, microseconds.

## Doc claims falsified
- `docs/idea/03-providers.md:765` "Routing, keys, pools, usage, and the admin UI need no changes" — `services/models/refresh.ts:74` (openrouter), `services/cost/prices.ts:87,94,122` (kimi), `services/routing/failover.ts:387` (anthropic-oauth), `scheduler/tasks/idle-account-probe.ts:16` name providers.
- `providers/types.ts:19-21` "one file under `drivers/` plus one line in `registry.ts` — nothing else in the system changes" — omits the `ProviderId` union the idea doc itself lists, and the leaks above.
- `providers/rate-limit/parse.ts:20-22` "The parser never invents a reset … `estimated` belongs to the circuit breaker" — `parse.ts:128` emits `estimated` itself for inferred epoch-seconds.
- `providers/types.ts:94-96` "Drivers never estimate" — `classify.ts:133` `withEstimatedReset` (Kimi, OpenRouter) does.
- `scheduler/tasks/model-catalog-refresh.ts:46-48` "batchSize … bounds concurrency against a provider" — the loop is serial; it bounds tick length.

## Steps
1. 04.1: extend `messageRule` with status/type/anchor guards + quoted-span stripping + 2 KB cap (also closes 04.4's general case); tighten each driver's wording rule; fix `genericCreditsRule` for 404/model-not-found. Tests first. Update `docs/idea/03-providers.md` table.
2. 04.4: bound `kimi.ts:35`.
3. 04.2 + 04.8: strict `retry-after` numeric parse; status defaults for 408/425/529; hand the ceiling to the routing slice (`backoff.ts:30`) with a new env knob; drop OpenRouter's 408 rule.
4. 04.3: `catalogSweep` driver flag; remove literals from `refresh.ts`.
5. 04.5: `onRefreshError` + gauges + shared jittered timer.
6. 04.6 + 04.7: capped JSON read, `has_more` note, listing memoisation.
7. 04.10 then 04.9 (after owner ruling); fix the doc claims above in the same commits.

## Tests
- Extend: `apps/api/test/unit/providers/{failure-vendors,failure-anthropic-openai,rate-limit,provider-reset-regressions,opencode-go,opencode-oauth,registry}.test.ts`, `apps/api/test/unit/models/{refresh,listing,store}.test.ts`, `apps/api/test/unit/catalog/refresh-barriers.test.ts`. Add: `apps/api/test/unit/models/listable.test.ts`, one integration case for 04.1 (mocked upstream echo, asserts `UsageRecord` + account status).
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end.

## Done when
- Every echo body in 04.1 classifies as `invalid-request`/`model-unsupported`; genuine credit bodies unchanged; account status untouched in the integration case.
- No reset reaching the breaker exceeds the configured ceiling; `retry-after: 0x10` is ignored.
- `grep -rn '"openrouter"' apps/api/src/services/models` is empty.
- 64 KB adversarial Kimi body classifies in single-digit ms.
- A failing warm-catalog load produces a warn line and a stale `*_loaded_at` gauge.
- Listing/quota reads refuse bodies over the cap; `/v1/models` allocates no shipped-table rows per request.

## Not covered
- OAuth state/PKCE/TTL, one-shot enforcement, polling cadence, token persistence and logging: live in `services/accounts/connect/` and `services/accounts/` (outside this area) — only the pure builders/readers were audited.
- Upstream admission/concurrency limiter implementation: `providers/upstream-admission.ts` is types only; the limiter lives in the dataplane.
- Connection pooling/keep-alive: the `fetch` passed in is constructed in composition, not here.
- Real upstream echo wording per vendor (04.1) not captured live; classifier behaviour verified with synthetic bodies only.
- Prior 101/03.16 (Gemini array-wrapped error body) still unfixed in `gemini.ts:110-114` and still `unverified` — no fixture exists.
- Tests under `apps/api/test/` were listed, not read line by line; did not check for tests encoding the 04.1 rule beyond the file names.
- `packages/core` config for `UPSTREAM_TIMEOUT_MS` defaults, and `routableStandIn`/`peekSuccess` internals, read only at call sites.
