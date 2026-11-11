# 02 — Data plane request path

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/dataplane/**` except `auth/`.

Paths below are relative to `apps/api/src/services/` unless rooted. Numbers marked *measured* come
from throwaway `bun test` scripts on this checkout (Bun 1.4.4, best-of-12, warm JIT), not from prod.

## Findings

### 02.1 high — routing scanner costs 8–37 ns/byte on realistic bodies; blows the 5 ms budget from ~150 KB up
- **Kind:** nn-violation (NN 8 overhead budget) / perf
- **Where:** `dataplane/body/scanner.ts:167` (per-byte `push` loop), `:175` (`skipString` fast path only for escape-free string runs), `:109`/`:265` (`stringBytes = []` allocated per captured string and per **every** object key), `dataplane/body/read.ts:98` (scan runs to EOF on every request)
- **Defect:** the scan-to-EOF grammar validator is a JS per-byte state machine whose only fast path is a long escape-free string; escapes and structure fall to closures per byte, synchronously on the event loop.
- **Failure scenario:** *measured*, ~1 MB bodies in 64 KiB chunks, user-first conversation: one escape-free 966 KB string 0.58 ms (0.6 ns/B); text with an escape every ~10 chars (code: `\n`, `\"`) 7.97 ms (7.9 ns/B); structure-dense tool inputs/schemas 35.99 ms (37 ns/B). When the first conversation item is not a plain user turn the same bodies cost 12.5 ms / 88 ms (opening capture stays live — cause **unverified**). A 300 KB Claude Code turn is 2.4–11 ms of blocking CPU before selection; every other in-flight stream stalls for that long. `JSON.parse` of the same 966 KB is 0.87 ms. Regression vs prior ledger `docs/plans/2026/10/02/101-deep-bug-sweep/01-edge-auth-security.md:12` (2.05 ms / 292 KB, pre full-grammar admission, commit `5590429`).
- **Fix:** keep the rule (duplicate top-level `model` and malformed JSON must still be refused — it is what stops a second `model` re-routing upstream), make it cheap. (1) After routing fields + opening capture are done, enter a skim mode: depth counter + string state only, no key decode/`stringBytes` below depth 1, no `createFrame` object per container (typed depth stack). (2) `string-validation.ts:41` `skipString`: consume simple two-byte escapes inline, leave the slow path to `\u`. (3) Find string ends with native `indexOf(0x22)` + backslash back-check. (4) Allocate `stringBytes` only when `capture` is true (`scanner.ts:265`). Target ≤2 ns/B on all three shapes. Update `docs/idea/01-architecture.md` performance section with the per-byte budget.
- **Test:** unit — existing `test/unit/dataplane/scanner-*.test.ts` + `routing-scanner.test.ts` must stay green (they are the grammar contract). Add a bench scenario (02.13), not a timing unit test.

### 02.2 high — response framing iterates every upstream byte into a `number[]`; a 60 KB non-streamed body costs 2.3 ms per pass, and it is passed twice
- **Kind:** nn-violation (NN 8 budget, time before first byte) / perf — root cause in the usage slice's file
- **Where:** `usage/response-framing.ts:137` (`for (const byte of chunk)`), `:168` (`line.push(byte)`), `:110`/`:177` (`Uint8Array.from(line)` then decode then `JSON.parse`); called pre-first-byte from `dataplane/success-wall.ts:111,161` and per chunk from `dataplane/chain-relay.ts:202`; `usage/response-observer.ts:23` (`snapshot()` freezes 2–4 objects) called per chunk at `chain-relay.ts:203`
- **Defect:** usage/terminal observation and the wall peek both run a byte-at-a-time JS framer over the whole response, and the peek's parse is thrown away and redone by the observer.
- **Failure scenario:** *measured*: one 60 KB `application/json` body through `createResponseFraming` = 2.32 ms, vs 0.076 ms for `TextDecoder` + `JSON.parse` of the same bytes (30×). A non-streamed passthrough answer near `UPSTREAM_ERROR_MAX_BYTES` pays it once in `peekSuccess` **before any byte reaches the client** and again in the relay observer: ~4.6 ms sync CPU per response. SSE: 9.7 µs per 127-byte `content_block_delta` chunk (observe + snapshot), i.e. ~76 ns/B and one `JSON.parse` per event on a same-dialect stream; 100 concurrent streams × 50 chunks/s ≈ 5 % of the one core.
- **Fix:** in `usage/response-framing.ts` (usage slice owns): JSON mode keeps chunk references and decodes once at `finish` (bounded by `maximumBytes`, salvage path unchanged past it); SSE mode scans for `\n`/`\r` with `indexOf` and decodes `subarray` slices, carrying only a split line. In dataplane: (a) `chain-relay.ts:203` call `terminal.observe` only when the observer reports a new frame, and have `snapshot()` return a cached object until state changes; (b) hand the peek's already-parsed first payload(s) to the observer instead of re-framing the replayed bytes (`success-wall.ts:239` replay → `chain-relay.ts` observer); (c) optional: skip `JSON.parse` for frames whose `event:` name is a pure delta once `modelOutput` is set and the dialect keeps usage elsewhere (`dataplane/model-output.ts:11`). Behavior unchanged; update `docs/idea/08-observability.md` only if (c) lands.
- **Test:** unit — existing `test/unit/usage/*framing*`/observer suites and `test/unit/dataplane/success-wall.test.ts`, `stream-wall.test.ts`, `relay-terminal.test.ts` stay green; add a framing case with a line split across three chunks and CRLF across a chunk boundary. Bench scenario in 02.13.

### 02.3 high — a `count_tokens` estimate never releases its active-request lease; 65,536 of them close the data plane
- **Kind:** bug / memory (confirmed by run)
- **Where:** `dataplane/orchestrator.ts:309` → `dataplane/count-estimate.ts:332`; lease taken at `dataplane/request-lifetime.ts:19`; bound at `dataplane/active-requests.ts:38` (`ACTIVE_REQUEST_MAX_ENTRIES` default 65,536, `config/relay-lifetimes.ts:9`)
- **Defect:** every other exit releases the lease (`chain.ts` end, `chain-relay.ts` settle, `chain-cancellation.ts`, `request-lifetime.ts` `fail`); the estimate branch returns a `Response` without touching it, and `holdLease` is still `held` because `recovery.chain` never ran.
- **Failure scenario:** scope holding only Claude subscriptions (the product's normal case); Claude Code posts `/v1/messages/count_tokens` before turns → each answer leaks one registry entry (lease + `AbortController` + accounting closure). Reproduced: registry `maximumEntries: 3`, three estimate answers → `size` 1, 2, 3; fourth and fifth request throw `RequestAdmissionUnavailableError`. In prod: after 65,536 estimates every `/v1` request is refused `503 request_admission_unavailable` until restart; frequent deploys have been masking it.
- **Fix:** release on the estimate exit — in `orchestrator.ts:308-309` call `input.activeRequest?.release()` (the raw lease, not `recovery.lease`) before returning, or better make it structural: in `dispatch()` (`orchestrator.ts:382-390`) release the lease whenever `serve` returns a response that no relay/chain took ownership of. No spec change.
- **Test:** integration (failure first) in `test/integration/count-tokens.test.ts`: harness with a registry, subscription-only scope, N estimate answers → `registry.size === 0` and a `UsageRecord` `outcome: "success"` each. Unit in `test/unit/dataplane/request-lifetime.test.ts`: `maximumEntries: 1`, two sequential estimates both answer `200`.

### 02.4 medium — forced-tool coercion buffers the whole upstream stream even when the vendor obeyed the force
- **Kind:** nn-violation (NN 8 "never buffer a stream" — a recorded decision, v2.37.4 / `22b62c4`; reported because it is wider than it needs to be)
- **Where:** `dataplane/forced-tool-coercion.ts:62` (`readRelayBody` to EOF), wired at `dataplane/chain-relay.ts:86`, selected by `dataplane/chain.ts:317`
- **Defect:** any request that forces a tool on a `thinkingOnByDefault` vendor has its entire response (stream included) read to the end before one chunk is written, although the classification is decidable at the first content block.
- **Failure scenario:** AI-SDK `generateObject` (`tool_choice: any`, `stream: true`) on MiniMax/OpenCode-Go: vendor answers correctly with `content_block_start {type: "tool_use"}`; router still holds every byte until `message_stop` → TTFT = full generation time, and the body is unbounded in memory (02.9).
- **Fix:** decide on the first `content_block_start`: `tool_use` → switch to passthrough for the rest (replay held prefix, as `success-wall.ts:239` does); `text`/`thinking` → keep buffering and coerce as today. Lives in `dataplane/forced-tool-coercion.ts` + `translate/shared/forced-tool-coercion.ts` (translation slice). Update `docs/idea/06-protocol-translation.md` forced-tool section.
- **Test:** unit `test/unit/dataplane/` new `forced-tool-coercion-stream.test.ts`: slow stream starting with `tool_use` → first client chunk arrives before upstream end; text-first stream still coerced byte-identically to today.

### 02.5 medium — passthrough relay is 4–5 chained JS streams per chunk, and the observer runs before the client's pull can
- **Kind:** perf (cost reasoned, not measured) / docs
- **Where:** `dataplane/upstream-deadline.ts:130` (`watchSilence`) → `dataplane/success-wall.ts:239` (`replay`) → `dataplane/relay.ts:61` (`TransformStream` via `pipeTo`) → `dataplane/relay-cancellation.ts:10` (`observeCancellation`) → `dataplane/relay-stream-end.ts:42` (`endsWithRouterError`), plus `dataplane/sdk-attempt-response.ts:22` on the SDK path
- **Defect:** each wrapper is its own `ReadableStream` with `highWaterMark: 0` and an `await reader.read()` per chunk, so one upstream chunk crosses five promise hops in JS and loses any native fetch-body→response path; and `relay.ts:64` "enqueue first" only queues — the downstream readers resume in later microtasks, after `onChunk` (02.2's framing + parse) has finished synchronously.
- **Failure scenario:** every same-dialect streamed chunk: 5 stream hops + observer cost sit between the upstream byte and the socket write; the first chunk's observer time is added time-to-first-token (small, non-zero), and the comment at `relay.ts:63` claims the opposite.
- **Fix:** one pull-based relay stream owning a single `reader.read()` loop that (1) stamps the idle clock, (2) drains the peek's held chunks first, (3) enqueues, (4) defers `observer.onChunk` to a microtask/`queueMicrotask` after the enqueue, (5) on read error appends the router error event when the client is still there, (6) reports cancel. Keep `relay.ts` schema-free; translated relay unchanged. Measure with `bin/bench` before/after (added TTFT p95, overhead p99) and keep the change only if it moves. Fix the comment either way.
- **Test:** existing `test/unit/dataplane/relay.test.ts`, `causal-relay.test.ts`, `hung-relay-cancellation.test.ts`, `stream-wall.test.ts`, `upstream-deadline.test.ts`, `header-cancellation.test.ts` are the contract; add one asserting a chunk is readable by the client before `onChunk` has run.

### 02.6 medium — forced-tool passthrough body is fully parsed twice and re-stringified per attempt; translated body re-stringified per attempt
- **Kind:** perf
- **Where:** `dataplane/chain-body.ts:62` → `dataplane/body/forced-tool-thinking.ts:74` (parse + stringify); `dataplane/chain.ts:268,317` → `dataplane/forced-tool-coercion.ts:25` (second parse of the result); `dataplane/translate-body.ts:180,208` (`{...translated, model}` + `JSON.stringify` on every `bodyFor` call)
- **Defect:** nothing is memoized across the two readers or across failover attempts, and the marker test is a raw substring so `"tool_choice"` anywhere in the transcript triggers the full parse.
- **Failure scenario:** *measured* on ~950 KB bodies containing `tool_choice`: `disableThinkingForForcedTool` 5.6–9.1 ms + `forcedToolOfBody` 2.6–5.8 ms per attempt, on every think-by-default vendor attempt; a 5-account failover of a translated 1 MB request stringifies it 5 times with identical output when alias and cache key agree.
- **Fix:** one per-request memo in `ChainContext`: parse once, keep `{forcedTool, editedBytes}` keyed by `(upstreamModel bytes identity, vendor flags)`; `forcedToolOn` reads the memo instead of re-parsing. In `translate-body.ts` cache the encoded bytes per `shape|upstreamModel|cacheKey|sessionId|thinkingDefault` beside `converted`. Bounded by candidates per request.
- **Test:** unit `test/unit/dataplane/forced-tool-thinking.test.ts` + `translate-body.test.ts`: same output bytes; spy asserts one parse / one stringify across two attempts on same-shaped accounts.

### 02.7 medium — an attempt that throws after the upstream was started is filed as "preparation": no account row, no recovery outcome
- **Kind:** bug
- **Where:** `dataplane/chain.ts:204-217` (catch), reachable from `dataplane/attempt.ts:171` (`parseRateLimit`), `:250` (`classifyFailure`), and the redaction calls after the `try` at `attempt.ts:159-170`
- **Defect:** the catch assumes nothing reached the provider: it rewinds `progress`, drops the candidate, writes no attempt `UsageRecord`, strikes nothing, and never calls `recovery.finish` although `lifetime.started()` / `recovery.started()` may be true.
- **Failure scenario:** a driver hook throws on an unexpected header/body shape after `fetch` resolved (provider drift) → upstream was contacted (possibly billed), the usage feed shows only a null-account `no_healthy_account` row (`chain-refusals.ts:59`), the same account is retried by every request with no breaker count, and a designated recovery permit is left consumed until the coordinator's own outcome timeout.
- **Fix:** in the catch, branch on `lifetime.started()`: started → `recovery?.finish("uncertain")`, record an attributed row (`recordAttemptFailure` with a `server-error` failure, `errorClass` = thrown name), `health.recordFailure` as a `server-error`, keep `progress` (the attempt happened); not started → today's path. `docs/idea/05-routing-and-failover.md` attempts section: one sentence.
- **Test:** unit `test/unit/dataplane/chain.test.ts`: driver stub whose `parseRateLimit` throws after a `200` → one row with `accountId` set and `outcome: "upstream_error"`, breaker `consecutiveFailures === 1`, next candidate served.

### 02.8 medium — every request walks and re-allocates the whole account catalog three times, unscoped; cold sessions on HTTP-only keys pay a binding query
- **Kind:** perf / db
- **Where:** `dataplane/snapshot.ts:97-117` (`reconcile` + `overlayHealth` spread + `mergeQuotaWindows` per account, per request, per recovery-wait re-select), `dataplane/recovery-access.ts:72` (fresh object + `Date` per recovering account per call), `dataplane/plan.ts:162` (`new Map(catalog.accounts()…)` per request) and `:230` (`new URL` per candidate, attempted or not), `dataplane/session-binding.ts:43,54` (gate is "any subscription in the catalog", not "in this key's scope"), read awaited at `dataplane/orchestrator.ts:161`
- **Defect:** cost is O(all accounts) allocations per request regardless of key scope, and a key that can never reach a subscription still awaits `SessionStore.binding` (one indexed Postgres query per new session key, before the first upstream byte).
- **Failure scenario:** 60 accounts, key scoped to a 3-account HTTP pool → 60 reconciles + 60 overlay objects + 60-entry Map per request; each new conversation on that key adds a DB round trip the HTTP path never uses (only the SDK path writes bindings).
- **Fix:** (1) catalog install builds `byId` once (`services/catalog/store.ts`, catalog slice) and `RoutingCatalog` exposes `account(id)`; `plan.ts`/`orchestrator.ts:288` use it. (2) Memoize `overlayHealth` per account on `(account object, health state object)` identity — both are replaced, never mutated (`health.ts:132`) — so a steady state allocates nothing. (3) Resolve `url` lazily at dispatch. (4) Precompute per catalog version the set of subscription account ids and their pool ids; `bindings.read` skips when `key.scope` cannot intersect it. Edge to keep: a session bound earlier to a now-out-of-scope subscription loses its `x-router-session-restart` header — decide and state it in `docs/idea/05-routing-and-failover.md`.
- **Test:** unit `test/unit/dataplane/session-binding.test.ts` (HTTP-only scope beside a subscription elsewhere → repository `findByKey` not called); snapshot memo test asserting referential equality across two builds with no health write; `plan.test.ts` unchanged.

### 02.9 medium — `readRelayBody` has no size bound
- **Kind:** memory
- **Where:** `dataplane/relay-body-read.ts:1`, used by `dataplane/relay-translate-body.ts:68` (translated non-stream body and `collectStream`) and `dataplane/forced-tool-coercion.ts:62`
- **Defect:** an upstream-controlled body is accumulated whole with no cap; only the attempt's total deadline (default 600 s) ends it.
- **Failure scenario:** a misbehaving or operator-mistyped OpenAI-compatible endpoint streams unbounded JSON to a translated non-streaming request → the router buffers until the deadline; a handful of such requests exhaust the pod.
- **Fix:** add a `maxBytes` argument fed from config (new `UPSTREAM_BUFFERED_BODY_MAX_BYTES`, NN 11) → over the cap fail the relay with `TranslationStreamError("translation_protocol_error", …)`; forced-tool path falls back to passthrough of what was read plus the rest. Document in `docs/idea/09-deployment.md`.
- **Test:** unit `test/unit/dataplane/` `relay-body-read.test.ts`: stream past the cap → rejects, reader cancelled; translated relay records `router_error`.

### 02.10 low — `recentTokens` is a since-boot total, not recent
- **Kind:** bug
- **Where:** `dataplane/health.ts:169`; read by `routing/policies/least-used.ts:35`
- **Defect:** the counter only grows (output tokens) and is zeroed only by `health.reset`, so `least-used`'s tiebreak (or primary, with `leastUsedMeasure: "recent-tokens"`) ranks on lifetime totals.
- **Failure scenario:** operator hits "Re-check now" on one account (or adds one) → its counter is 0 → it wins every tie until it has out-generated accounts that have been up for days.
- **Fix:** two-bucket decaying window in the health store with a configured width (`LEAST_USED_TOKEN_WINDOW_SECONDS`, NN 11), rotated lazily on write/read against the injected `now`. Update `docs/idea/05-routing-and-failover.md` least-used paragraph.
- **Test:** unit `test/unit/dataplane/health.test.ts`: tokens recorded at t0 are gone at t0 + 2 windows.

### 02.11 low — quota writer persists one window per round trip, sequentially
- **Kind:** db
- **Where:** `dataplane/quota-writer.ts:91-134`
- **Defect:** off-path flush awaits one `upsert…QuotaWindow` per window per account in series.
- **Failure scenario:** 30 accounts × 3 windows after a busy interval → 90 sequential statements per flush; slow Postgres stretches the flush past its interval and shutdown drain.
- **Fix:** batch per flush with one multi-row `INSERT … ON CONFLICT` (repository in `packages/db`, DB slice), keeping the per-row observed-facts predicate; requeue the failed batch as today.
- **Test:** extend `test/unit/dataplane/quota-writer.test.ts` — one repository call per flush, partial failure requeues all rows.

### 02.12 low — four files over the 300-LOC rule
- **Kind:** structure
- **Where:** `dataplane/orchestrator.ts` (398), `dataplane/count-estimate.ts` (353), `dataplane/chain.ts` (325), `dataplane/egress/mode.ts` (325)
- **Defect:** CLAUDE.md "Files ≤300 LOC".
- **Failure scenario:** n/a.
- **Fix:** move `couldHaveServed`/`isSubscription`/`everyCandidateIsASubscription` + the empty-chain branch to `unservable-scope.ts`; split `count-estimate.ts` into walk + response; extract the chain's two drop branches. No behavior change.
- **Test:** existing suites.

### 02.13 medium — `bin/bench` cannot see 02.1/02.2: 1 KB `"x"` prompt, tiny responses
- **Kind:** test-gap
- **Where:** `apps/api/bench/run.ts:34` (`promptBytes: 1_024`), `apps/api/bench/scenarios.ts:180` (`"x".repeat(n)` — the scanner's one fast path), `apps/api/bench/upstream.ts:148` (5-byte answers)
- **Defect:** the budget gate measures the cheapest possible body and response, so the two largest per-request costs are outside it.
- **Failure scenario:** `bin/bench` passes at <5 ms while a 300 KB tool-heavy turn costs 11 ms in the scanner alone.
- **Fix:** add scenarios: 300 KB and 1 MB prompts built from escaped code text + nested tool inputs; a 60 KB non-streamed JSON answer; a 200-chunk SSE answer. Report them beside the baseline in `bench/baseline.json`; update `docs/idea/08-observability.md:1016-1017`.
- **Test:** the scenarios are the test.

## Checked, not a bug
- Client auth never goes upstream; upstream credential/tenant headers never come back: allowlists at `dataplane/egress/headers.ts:2-12`, `Connection`-nominated names dropped; error bodies scrubbed with the live secret set (`dataplane/attempt.ts:190-198`, `error-body.ts:45`).
- No retry after bytes: success branch returns from the loop (`dataplane/chain.ts:256-281`); wall-in-2xx is decided inside `peekSuccess` before commit (`dataplane/attempt.ts:209`), hold bounded by `UPSTREAM_STREAM_WALL_HOLD_MS` (always wired, `composition/dispatch-options.ts:50`).
- `bindings.read` before selection is the sanctioned "warm cache, one indexed query on miss" (`dataplane/session-binding.ts:11-16`); see 02.8 for the scope gate only.
- Half-open probe hold has an exit: `probeHeldUntil` expires after `probeHoldMs` even if `release` is lost (`dataplane/health.ts:217-231`).
- Idle/first-byte/total clocks, the client listener and body closures are dropped on every exit through the single `release` (`dataplane/upstream-deadline.ts:94-103`); backpressure is not counted as upstream silence (`:150-152`).
- Body-read abort listener is per pending read and removed (`dataplane/body/read.ts:97-123`); `pause`/`sleepUnlessAborted` clear timer and listener both ways.
- Every pre-dispatch refusal writes one row: `request-accounting.ts:135-180` (admission, shutdown, cancel, limiter, bad body), `orchestrator.ts:221-233` (selection/plan), `chain-refusals.ts:57-69`.
- Usage writes are enqueue-only on the path (`deps.usage.record`, queue in `usage/queue.ts`).
- All-candidates-fail answer is ranked, never a bare 500: `dataplane/chain-error.ts:62-99`; a recovering account awaiting its permit outranks a held `429` and is waited for (`chain-refusals.ts:27-55`, `recovery-wait.ts`).
- Rate limiter is bounded (`maxKeys` 4,096) and charged before the body is read (`dataplane/limits.ts`); its `evict` is O(maxKeys) per new key once full — only past 4,096 live limited keys.
- Rotation counters, health states, observations are keyed per account/pool and dropped on catalog removal (`composition/warm-state.ts:98`).
- `CredentialDecryptError` on one account ranks at the floor and never buries a `429` (`chain-error.ts:97-99`).

## Doc claims falsified
- `docs/idea/01-architecture.md:196` "opaque body that is never interpreted is relayed, not parsed": every same-dialect response frame is framed and `JSON.parse`d for usage (`usage/response-framing.ts:26-37` via `dataplane/chain-relay.ts:202`), and a non-streamed body is read whole (≤64 KiB) and parsed before commit (`dataplane/success-wall.ts:111-176`).
- `dataplane/relay.ts:63` comment "Everything after this line happens on time the client already has": the observer runs synchronously before any downstream reader resumes (02.5).
- `docs/idea/08-observability.md:1016-1017` presents `bin/bench` as the proof of "<5 ms added p99 / zero added TTFT": it measures a 1 KB escape-free prompt and a 5-byte answer (02.13).
- `dataplane/health.ts:25` / `routing/policies/least-used.ts:6` "recent token spend": never decays (02.10).
- No SQLite / `DATABASE_PATH` mention found in this area.

## Steps
1. 02.3: release the lease on the estimate exit (structural release in `dispatch()`), tests first. Own commit — it is the outage.
2. 02.13: add the large-body / large-answer bench scenarios and record a baseline, so 02.1/02.2/02.5 have numbers to move.
3. 02.1: scanner skim mode + inline escapes + lazy `stringBytes`; grammar suites unchanged; re-run bench.
4. 02.2: with the usage slice — rewrite `response-framing.ts` hot loops; then dataplane side (cached snapshot, peek hand-off).
5. 02.7: started-vs-unstarted branch in the chain catch.
6. 02.6: per-request memo for forced-tool edit + encoded translated bytes.
7. 02.4 + 02.9: early passthrough decision in forced-tool coercion; `maxBytes` on `readRelayBody` with its env knob.
8. 02.8: catalog `byId`, overlay memo, lazy URL, scope-gated binding read (coordinate with catalog slice).
9. 02.5: single-stream relay, only if step 2's numbers justify it; fix the comment regardless.
10. 02.10, 02.11, 02.12: decay window, batched quota upsert (DB slice), file splits.
11. Spec edits named per finding; `CHANGELOG.md`; version bump.

## Tests
- Add/extend: `test/integration/count-tokens.test.ts`, `test/unit/dataplane/request-lifetime.test.ts`, `chain.test.ts`, `forced-tool-thinking.test.ts`, `translate-body.test.ts`, `session-binding.test.ts`, `health.test.ts`, `quota-writer.test.ts`, new `forced-tool-coercion-stream.test.ts`, `relay-body-read.test.ts`; usage framing suite (split-line cases).
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end; `bin/bench` for steps 2–4 and 9. Never a bare root `bun test`, never `bin/check` per slice.

## Done when
- N estimate answers leave `registry.size === 0`; the reproduction in 02.3 answers `200` indefinitely.
- New bench scenarios: 1 MB mixed prompt adds <2 ms scanner time; 60 KB non-streamed answer adds <0.3 ms before first byte; `router_overhead_seconds` p99 <5 ms on all scenarios.
- A forced-tool stream that starts with `tool_use` reaches the client before the upstream ends.
- A post-start throw yields an account-attributed row and a breaker count.
- HTTP-only scoped key performs zero session-table reads.
- No file in the area over 300 LOC.

## Not covered
- `catalog-listing.ts`, `models.ts`, `quota-catalog.ts`, `gauge-observation.ts`, `attempt-log.ts`, `chain-drop-log.ts`, `body/{opening,primitive,structural,string-validation,utf8-validation,opaque-array-run}.ts` skimmed, not traced line by line; the 2.5× scanner slowdown on a non-user first item (02.1) is measured but its cause is unverified.
- 02.5's cost is reasoned from the code, not measured; Bun's native stream fast-path behavior was not tested.
- AES-GCM decrypt + stored-OAuth parse per attempt (`dataplane/egress/credential.ts:50`) not measured.
- Integration tests under `apps/api/test/integration/` were grepped for coverage of the findings, not read in full; no test was found that encodes a wrong rule.
- Recovery coordinator behavior behind `RecoveryAccess` (permit outcome timeout cited in 02.7) lives outside this area and was not read.
- All timings are single-machine micro-benchmarks, not prod traces.
