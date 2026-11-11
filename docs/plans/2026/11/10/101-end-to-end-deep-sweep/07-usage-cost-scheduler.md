# 07 — Usage + Cost + Scheduler

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/usage/`, `apps/api/src/services/usage-read/`, `apps/api/src/services/usage-report/`, `apps/api/src/services/cost/`, `apps/api/src/scheduler/`.

## Findings

### 07.1 high — Response observer walks every relayed byte in JS and JSON-parses every SSE event
- **Kind:** nn-violation (8, overhead budget) | perf | memory
- **Where:** `apps/api/src/services/usage/response-framing.ts:137-169` (per-byte loop, `line: number[]`), `:110` (`Uint8Array.from(line)` per line), `:39` (`JSON.parse` per event); `apps/api/src/services/usage/response-usage.ts:5-10` (zod `z.record` parse, called ~5x per event from `response-usage.ts:18-37` and `response-terminal.ts:14-18`); `apps/api/src/services/usage/response-salvage.ts:274-367` (per-byte state machine past the bound); caller `apps/api/src/services/dataplane/chain-relay.ts:202`.
- **Defect:** usage/terminal observation iterates each chunk byte-by-byte through `for…of`, pushes bytes into a boxed `number[]`, and fully parses + zod-copies every frame, synchronously on the shared event loop for every relayed chunk.
- **Failure scenario:** measured with a throwaway bench against the real module (Bun, this host). SSE, 4003 Anthropic events / 551 KB: 19 ms total, 4.7 µs/event, 34 ns/byte. Non-stream JSON, 16 KB chunks: 19 KB body 1.3 ms; 72 KB 6.0 ms; 600 KB 27 ms; 2.4 MB 100 ms — each 16 KB chunk holds the loop 0.8 ms (under the 64 KB bound) to 2.2 ms (salvage path). `onChunk` fires after enqueue, so the chunk itself is not delayed, but every other in-flight request waits: one large non-stream answer or embeddings body (multi-MB JSON) costs tens to hundreds of ms of loop time in ~2 ms slices, against a <5 ms p99 budget. Memory: `line` holds up to `UPSTREAM_RESPONSE_OBSERVATION_MAX_BYTES` (65 536, max 1 048 576) array elements per in-flight non-stream response, several times the byte size of the same data as a `Uint8Array`.
- **Fix:** (1) `response-framing.ts`: scan with `chunk.indexOf(10, from)` / `subarray`, keep pending partial line as `Uint8Array[]` + byte count, decode once per complete line; for `application/json` keep chunk refs up to the bound and concat once in `finish()`. (2) Skip `JSON.parse` for frames that cannot carry usage/terminal/error: Anthropic by `event:` name (`content_block_delta`, `content_block_start`, `content_block_stop`, `ping`), other dialects by a byte prefilter for `"usage"` / `"error"` / `"status"` / `"type":"response.` — only when `descriptor.inspectPayload` is absent or the descriptor declares the markers it needs (add an optional `inspectMarkers` to `ResponseObservationDescriptor`; that type lives in `providers/types.ts`, providers slice). (3) Replace `responseObject`'s zod parse with a plain `typeof === "object" && !== null && !Array.isArray` guard (`response-usage.ts:7-10`). (4) `response-salvage.ts`: add `pushChunk(bytes, start, end)` with a tight indexed loop and a fast skip while `inString && capture === null` (scan to next quote/backslash). Keep `response-salvage-parity.test.ts` green. Update `docs/idea/08-observability.md` (observation ceiling paragraph near :1431) with the cost bound.
- **Test:** unit — existing `apps/api/test/unit/usage/response-framing.test.ts`, `response-usage.test.ts`, `response-salvage-parity.test.ts`, `response-passthrough.test.ts` must stay green; add split-frame cases (frame boundary inside a multi-byte UTF-8 char, CRLF split across chunks, `data:` split across chunks) for the new scanner, and a skipped-event case proving `message_delta` usage is still read when deltas are not parsed. Add an observer leg to `bin/bench` (ns/byte for SSE and JSON) so a regression is visible.

### 07.2 high — Usage summary labelling is O(rows × points) and blocks the data-plane event loop
- **Kind:** nn-violation (8, shared loop) | perf
- **Where:** `apps/api/src/services/usage-read/summary-view.ts:57-76` (`breakdownRow`: `points.filter(point => point.id === id)` + `new Date(point.at).toISOString()` per row), called per row from `summary-view.ts:37` (`label`), `buckets.ts:35,56`, `summary.ts:134`.
- **Defect:** every breakdown row re-scans the whole dimension's series points instead of grouping them once.
- **Failure scenario:** measured: 100 groups × 30 buckets = 6.5 ms per dimension; 100 groups × 400 buckets (`breakdownMaxRows` 100, `maxChartPoints` 400 — a lifetime or long custom window on a busy deployment) = 96 ms per dimension, six dimensions per summary → up to ~0.5 s of synchronous work on the loop that also relays every stream, each time an operator opens or refreshes `/usage`.
- **Fix:** in `summary-view.ts`, build `Map<id, Map<isoAt, requests>>` once per dimension (one pass over `points`) and pass the per-id map into `breakdownRow`; the query already emits `at` in ISO form (`usage-history-repository.ts` `to_char … "Z"`), so drop the `new Date().toISOString()` round-trip or do it once per distinct `at`. Same helper for `ownerRows`/`toolRows`.
- **Test:** unit — extend `apps/api/test/unit/usage/history-summary.test.ts` / `usage-read.test.ts`: identical output before/after for null ids, duplicate `at`, ids absent from points; add a 100×400 case asserting a wall bound loose enough for CI (e.g. <20 ms) or an operation count via an injected counter.

### 07.3 low — Model-catalog first-tick delay is a constant in code
- **Kind:** nn-violation (11)
- **Where:** `apps/api/src/scheduler/tasks/model-catalog-refresh.ts:65,73` (`STARTUP_DELAY_MS = 30_000`).
- **Defect:** an interval is hard-coded rather than read from env.
- **Failure scenario:** operator cannot move the boot-time catalog fan-out (one upstream listing per account, 30 s after every restart) without a code change.
- **Fix:** add `MODEL_CATALOG_REFRESH_STARTUP_DELAY_SECONDS` to the scheduler env block (`apps/api/src/config/` — config slice), pass it through `createModelCatalogRefreshTask` deps from `tasks/index.ts:252`; document in `docs/idea/09-deployment.md`.
- **Test:** unit — `apps/api/test/unit/scheduler/model-catalog-refresh.test.ts`: `startupDelayMs` equals the injected value, clamped to `intervalMs`.

### 07.4 high — A Postgres outage longer than two flush intervals discards usage records while the queue is nearly empty
- **Kind:** bug (data loss)
- **Where:** `apps/api/src/services/usage/recorder.ts:137-158` (`retried` → `writeDiscarded`), `:160-172` (`drainAll`); policy stated at `docs/idea/08-observability.md:73-85`.
- **Defect:** the one-retry ladder cannot tell "database unavailable" from "this batch is unwritable", so a batch is thrown away after its second refusal even though the bounded queue (`USAGE_QUEUE_MAX` 10 000) exists precisely to ride out an outage.
- **Failure scenario:** Postgres restarts/fails over for 30 s; flush interval 1 s, batch 200. t1 batch A refused → held; t2 A refused again → discarded; t3 batch B refused; t4 B discarded; … up to 15 batches (every record that arrived during the outage, at ≤100 rps) are deleted with `depth` far below the ceiling. Each is an attempt's tokens and cost gone from every total, permanently. (Timing assumes the driver rejects promptly; if it instead waits out a connect timeout the loss is one batch per two timeouts — same mechanism.) Second trigger: one row the admission rejects (`UsageIdentityConflict` / `UsageHistoryExpired`, `packages/db/src/repositories/usage-batch-mutation.ts:51,69,79`) takes the other 199 records of its batch with it.
- **Fix:** this revisits the documented decision at `docs/idea/08-observability.md:73-85`; the decision's stated reason (a poison batch must not starve the queue) is kept, its blast radius is narrowed. In `recorder.ts`: let the writer classify the refusal — add `UsageWriter.isTransient?(error)` (implemented in `usage/fromEnv.ts` from the driver/SQLSTATE: connection refused/closed/timeout, `08*`, `57P*`, `53*`, `40001`, `40P01`). Transient → keep the batch as `retry` with no attempt cap (memory stays `maxQueued + batchSize`; the queue keeps shedding oldest on overflow, which is already counted). Non-transient → on the second refusal bisect the batch (halves, recursing to single rows) and discard only the rows that still fail, counting them under `disposition="discarded"`. Keep "stop the pass at the first refusal". Update `docs/idea/08-observability.md:73-85` and the `router_usage_write_failures_total` description.
- **Test:** unit, failure first — `apps/api/test/unit/usage/recorder.test.ts`: writer refuses 5 consecutive flushes with a transient error then accepts → `written` equals everything recorded, `writeDiscarded` 0; writer rejects only batches containing one marked record → exactly 1 discarded, rest written; overflow during a long transient outage still sheds oldest and counts. Update (not delete) the existing "discarded when the retry is refused too — one retry, never a loop" case to the non-transient path. Integration: a `UsageRecord` row exists for a request served while the writer was refusing.

### 07.5 medium — No run deadline in the scheduler; with the default single lock session one stuck task stops all background work on the replica
- **Kind:** bug (gate with no exit; trigger unverified)
- **Where:** `apps/api/src/scheduler/runner.ts:71-83,96-118` (no timeout around `task.run`), `:166-179` (`inFlight` never clears), `apps/api/src/config/env-reader.ts:209` (`SCHEDULER_LOCK_POOL_MAX_CONNECTIONS ?? 1`), `packages/db/src/session-advisory-lock.ts:184` (`occupied >= max` → `capacity`).
- **Defect:** a task whose `run` never settles holds its advisory lock and the replica's only lock session indefinitely; nothing in the runner bounds a run.
- **Failure scenario:** any awaited port without its own timeout hangs (a filesystem call on the config-dir volume in `config-dir-reap.ts` / `sdk-transcript-sweep.ts`, a subprocess that never exits, a fetch with no deadline). That task's `inFlight` entry stays forever; every other task on the replica answers `skipped_capacity` and re-polls each second; other replicas get `skipped_locked` for the stuck task. On the documented single-replica deployment janitor, `cooldown_recheck` (the bounded exit for `exhausted` and long cooldowns), credential keepalive and the usage rollup all stop until a restart. Visible only as `router_task_last_success` going stale. I did not find a concrete unbounded await in the ports I read (`discord-post.ts:41` is bounded); the mechanism is verified, the trigger is not.
- **Fix:** add `maxRunMs` to `ScheduledTask` (config per task or one `SCHEDULER_TASK_MAX_RUN_MINUTES`, env in config slice). In `runner.ts` `attempt()`: race `task.run` against the deadline; on expiry abort a per-run `AbortController` merged into `taskSignal`, record `failed` with `error: "run exceeded <n> ms"`, release the lock (return from the lock callback) and let the next tick proceed. Document in `docs/idea/01-architecture.md` (background work) and `docs/idea/09-deployment.md`.
- **Test:** unit — `apps/api/test/unit/scheduler/runner.test.ts`: a task that never resolves → after the injected deadline the tick result is `failed`, the lock callback has returned, `runNow` of a second task acquires, and a later tick of the first task starts a new run.

### 07.6 medium — The exhausted re-test ladder lives in one replica's memory
- **Kind:** bug
- **Where:** `apps/api/src/scheduler/tasks/exhausted-retest.ts:49` (`watches` Map), `:61-64`; same class at `cooldown-recheck.ts:91` (`lastLook`), `plan-quota-read.ts:46` (`lastLookAt`), `credential-keepalive.ts:53` (`attempts`).
- **Defect:** the doubling schedule rule 7 bounds (`EXHAUSTED_RECHECK_FIRST_MINUTES` → `…MAX_MINUTES`) is tracked per process, while the advisory lock hands each tick to whichever replica wins and `exhausted` itself is persisted.
- **Failure scenario:** (a) two replicas alternate lock wins: each starts and doubles its own watch, so an account is re-tested roughly once per replica per step rather than once, and the first re-test slips by a tick per extra replica. (b) every deploy/restart empties the map: an account exhausted for a week is re-tested one hour after each restart instead of at the 24 h ceiling. Each re-test is an upstream probe and an alert line. Precedent: the same defect was fixed for catalog rotation in #336 (`model_catalog_attempts`).
- **Fix:** persist the ladder: retest count and last retest instant per account (new columns or a small table — schema/repository belongs to auditor 08), read in `createExhaustedRetest` instead of `watches`; `stepExhaustedWatch` (`services/routing/exhausted-retest.ts`, routing slice) stays pure and takes the persisted watch. `lastLook`/`lastLookAt`/`attempts` only reorder or back off and may stay in memory; say so in a comment. Update `docs/idea/01-architecture.md` (rule 7 re-test) to state the ladder is shared.
- **Test:** unit — `apps/api/test/unit/scheduler/exhausted-retest.test.ts`: two task instances over one injected store, alternating ticks, produce exactly the single-instance retest instants; a fresh instance over a store holding `retests: 3` does not retest before `dueAt`.

### 07.7 medium — One usage summary re-reads the same facts 14 times and scans raw rows 8 more, with no single-flight
- **Kind:** perf | db
- **Where:** `apps/api/src/services/usage-read/summary.ts:44-95` (totals, series, 6 `historyBreakdown`, 6 `historySeriesBy` each rebuild `historySource`; `raw.latency`, `raw.outcomes`, 6 `rawBreakdown` each scan `usage_records` for the window with three `percentile_disc` sorts); `service.ts:49-60` (no coalescing of identical concurrent reads).
- **Defect:** each statement recomputes the four-source `facts` union (including the JSONB `payload->>'eventAt'` cast over the edge-day receipts), and the percentile reads sort the whole raw window per dimension, per page load.
- **Failure scenario:** `docs/idea/08-observability.md:321` cites ~400k windowed facts and ~200k raw rows; 14 fact scans + 8 raw sorts run serially on one snapshot connection per load. Two operators (or one double-refresh) run the full set twice concurrently, holding two pool connections for the duration; `bin/bench-usage` budgets a summary at up to 60 s.
- **Fix:** service side first: single-flight identical `(query, filter)` summaries in `service.ts` for the life of the in-flight promise (no TTL cache needed; config-free). Then collapse reads: one statement per family using `GROUPING SETS` over a single `facts` CTE for totals + the four column dimensions, and one raw statement with `GROUPING SETS` for latency/outcomes/breakdowns — the SQL lives in `packages/db/src/repositories/usage-history-repository.ts` / `usage-read-repository.ts` (auditor 08). Keep owner/tool on the folded path (#250). Update `docs/idea/08-observability.md` summary-cost section.
- **Test:** unit — `usage-read.test.ts`: two concurrent identical `summary()` calls hit an injected repository once; differing filters do not coalesce. Bench: `bin/bench-usage` buffers leg before/after.

### 07.8 medium — Anthropic one-hour cache writes are priced at the five-minute rate
- **Kind:** bug (cost accuracy) — unverified against a live response
- **Where:** `apps/api/src/services/cost/tables/anthropic.ts:16-44` (`cacheWritePerMtok = input × 1.25`, comment "A response never says which cache TTL was written"); `apps/api/src/services/usage/response-usage.ts:53-54` (reads only `cache_creation_input_tokens`); `apps/api/src/services/usage/tokens.ts:5-10` (one `cacheWriteTokens` counter).
- **Defect:** the Messages API usage object also carries `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`; the observer ignores it, so 1 h writes (2× input) are estimated at 1.25×.
- **Failure scenario:** a client using 1 h cache TTL writes 1 M cache tokens on a $4/MTok model: real $8.00, recorded $5.00 — every such write under-reports by 37.5 %, in both the metered and the notional totals. Not confirmable from this repo (no real provider in tests); no code path here references `ephemeral_1h_input_tokens`.
- **Fix:** capture a redacted usage frame per `docs/research/claude-wire.md` rules to confirm the field. Then: add `cacheWrite1hTokens` (subset of `cacheWriteTokens`) to `TokenCounts`, read it in `readResponseUsage` for the anthropic dialect, add `cacheWrite1hPerMtok` to `RateCard` (default = `cacheWritePerMtok`, Anthropic = input × 2), price the split in `estimate.ts:93-98`. Persisting the split needs a column (auditor 08); without one, price at estimate time only. Fix the claim at `docs/idea/08-observability.md:124`.
- **Test:** unit — `apps/api/test/unit/usage/response-usage.test.ts` (frame with the nested object), `apps/api/test/unit/cost/estimate.test.ts` (1 h write priced at 2×, absent split unchanged).

### 07.9 low — Orphan-run maintenance query runs before every tick, including the one-second capacity retries
- **Kind:** perf | db
- **Where:** `apps/api/src/scheduler/runner.ts:94` (`beforeTick` precedes the lock), `:192-199` (capacity retry at `capacityRetryMs`), `apps/api/src/scheduler/orphan-runs.ts:21-29`.
- **Defect:** process-wide maintenance is invoked per task tick and before admission, so a tick that is about to be refused for capacity still spends a `listInterruptedTasks` query.
- **Failure scenario:** default lock pool of 1; the six-hourly idle probe or a janitor backlog runs for minutes; every task that comes due meanwhile re-ticks each second → up to 13 maintenance queries/s on the main pool for the whole run, all returning nothing.
- **Fix:** in `fromEnv.ts:40-46` wrap the maintenance in a process-wide minimum gap (reuse `localCapacityRetryMs`-independent config, e.g. the janitor interval) and single-flight it; or call it only after a tick acquired its lock (`runner.ts`, after the lock callback returns).
- **Test:** unit — `apps/api/test/unit/scheduler/orphan-runs.test.ts` / `runner.test.ts`: N capacity-skipped ticks inside the gap invoke the repository once.

### 07.10 low — A throwing `onTick` permanently disarms that task's timer
- **Kind:** bug
- **Where:** `apps/api/src/scheduler/runner.ts:169-173` (`deps.onTick?.(result)` inside the `.then`), `:192-200` (`void run(task).then(reschedule)` with no rejection branch).
- **Defect:** the "must not throw" contract on `onTick` is not defended; a throw rejects `pending`, the reschedule callback never runs, and the rejection is unhandled.
- **Failure scenario:** a metrics label error in `metrics.observeTask` (`composition/runtime-scheduler.ts:142`) on one tick → that task never runs again on this replica until restart.
- **Fix:** try/catch around `deps.onTick` with a `logger.error`; add a rejection handler on `runner.ts:192` that logs and re-arms with `task.intervalMs`.
- **Test:** unit — `runner.test.ts`: `onTick` throws once → the task ticks again on the next interval.

### 07.11 low — Four periodic tasks load every account row in full
- **Kind:** db
- **Where:** `apps/api/src/scheduler/tasks/credential-keepalive.ts:61` (every ~180 s), `quota-floor.ts:70`, `login-lifetime-watch.ts:40`, `model-catalog-refresh.ts:77`; `packages/db/src/repositories/account-repository.ts:88-97` (`select()` — all columns, encrypted credential blob included).
- **Defect:** tasks that need id/provider/status fetch whole rows, including ciphertext, on every tick.
- **Failure scenario:** 200 accounts × every 3 minutes × N replicas winning in turn: ciphertext pulled into the scheduler heap for a status filter. Bounded, but needless exposure and allocation.
- **Fix:** add a projection (`listForBackground`: id, provider, status, label, lastUsedAt) in the account repository (auditor 08) and use it from the three tasks that never touch credentials; keepalive needs only id/provider/status too (`readMetadata` reads the config dir, not the row).
- **Test:** unit — each task's test asserts it works with rows lacking credential fields.

### 07.12 low — Small repeated-work spots
- **Kind:** perf
- **Where:** `apps/api/src/services/cost/book.ts:133,140` + `prices.ts:93` (`modelLookupKeys` — trim, lowercase, regex — run three times per priced attempt on the request path); `apps/api/src/services/usage-read/filter.ts:64,68` (`ids.includes` / `wanted.includes` inside filters, keys × 500); `apps/api/src/scheduler/tasks/exhausted-retest.ts:54-55` (`known.some` per watch); `apps/api/src/services/usage/response-observer.ts:23-32` (`snapshot()` allocates three frozen objects and is called once per chunk by `chain-relay.ts:203`).
- **Defect:** avoidable recomputation / array-as-set.
- **Failure scenario:** per attempt three normalisations instead of one; per chunk three allocations; the rest are admin/tick paths.
- **Fix:** compute keys once in `lookupIndexed` and pass them to an internal `lookupRatesByKeys`; use `Set`s in `filter.ts` and `exhausted-retest.ts`; give the observer cheap `terminal`/`failure` getters so the relay need not snapshot per chunk (relay change belongs to the dataplane slice).
- **Test:** existing `cost/lookup.test.ts`, `usage/filter.test.ts`, `scheduler/exhausted-retest.test.ts` unchanged and green.

### 07.13 low — A failing periodic price-book refresh is silent
- **Kind:** bug (swallowed failure)
- **Where:** `apps/api/src/services/cost/book.ts:70-78` (`void refresh().catch(() => undefined)`), no logger in `PriceBookDeps` (`:46-52`).
- **Defect:** a refresh that fails every tick leaves another replica's price edit unapplied here forever with no log line or metric; only `loadedAt()` moves.
- **Failure scenario:** the override query starts failing after a migration or permission change; this replica keeps pricing on the old overrides and nothing says so.
- **Fix:** inject a logger (or `onRefreshError`) into `PriceBookDeps`, log at `warn` throttled per interval with `describeRedacted`; expose `loadedAt` age as a gauge if one is not already exported (observability slice).
- **Test:** unit — `apps/api/test/unit/cost/price-book.test.ts`: failing `load` on a timer tick calls the injected reporter and keeps the previous snapshot.

## Checked, not a bug
- Usage write is off the request path: `record()` is a synchronous bounded push (`recorder.ts:192-198`, `queue.ts:56-66`), flush on an unref'd interval, one drain at a time (`recorder.ts:175-182`).
- Queue is bounded and sheds oldest with a counter; head-index reclaim is amortised O(1) and bounded at 2× ceiling (`queue.ts:47-53`).
- Batch insert is multi-row, chunked under the bind ceiling, one transaction (`packages/db/.../usage-batch-mutation.ts:95-104`); retry is idempotent via `eventId` + receipts + `onConflictDoNothing` (`:101`, `:150-158`). No FK on `usage_records` dimensions, so a deleted key/account cannot poison a batch.
- Rollups are incremental at write time (`applyUsageContributions` upsert in the admission transaction); receipts make re-runs additive-once; late rows land on their event day. `usage_rollup` is only legacy adoption, bounded batches, resumable (`usage-rollup.ts:17-25`).
- Flush interval, batch size, queue ceiling, log throttle, shutdown drain are env (`config/env-reader.ts:279-281`, `usage/fromEnv.ts:77-78`).
- Shutdown drains with a deadline and counts what is abandoned (`services/shutdown/writer-lifecycle.ts:23-69`).
- Advisory lock: session lock taken and released on the same reserved connection, from a dedicated pool; connection loss retires the generation and aborts holders; unlock failure retires the session (`packages/db/src/session-advisory-lock.ts:147-166,176-263`). A throwing task is converted to a `failed` row and the lock is released in `finally` (`runner.ts:71-83`, lock `run` finally).
- A task cannot lap itself: `inFlight` shares the tick and the next timer is armed only after settle (`runner.ts:166-205`). Timers are unref'd and cleared in `stop()` (`:244-245`).
- Retention deletes are bounded id-subselect batches, drained, abort-checked between batches (`tasks/sweep.ts:71-89`, `packages/db/.../bounded-delete.ts:50-61`); `scheduled_task_runs_started_at_idx` and `usage_records_created_at_idx` serve them. Every window comes from `env.retention` (`janitor.ts:85-93`).
- Receipts (`usage_contributions`) kept for `RETENTION_USAGE_DAILY_DAYS` (730) while raw rows go at 90: deliberate and documented (`docs/idea/09-deployment.md:195`, `docs/idea/08-observability.md:1395-1397`). It does mean a per-attempt table at 8× the raw window; noted for auditor 08, not reported.
- `SCHEDULER_LOCK_POOL_MAX_CONNECTIONS=1` serialising tasks per replica is an accepted, documented gap (`docs/idea/11-anthropic-agent-sdk.md:309-312`); 07.5 is about the unbounded case only.
- Keepalive reads timestamps and a presence flag only (`credential-keepalive.ts:62-69`, `credential-keepalive-selection.ts:54-72`); no token is read or logged.
- Exhausted re-test doubling is bounded by `maxMs` (`services/routing/exhausted-retest.ts` `retestWait`); the per-replica issue is 07.6.
- Cost: lookup is Map/own-property, not a scan (`book.ts:126-146`, `prices.ts:81-95`); unknown price → NULL, never 0 (`estimate.ts:79,85`); per-attempt value is rounded once to 6 dp and summed as `numeric` in SQL, so no float accumulation; out-of-range estimates become unknown rather than poisoning a batch (`estimate.ts:103-107`); override precedence account → provider → shipped (`book.ts:126-146`).
- Weekly report: delivery is claimed with a compare-and-set, capped by `maxDeliveryAttempts`, POST has a timeout, webhook URL is scrubbed by the redactor (`delivery.ts:157-181`, `discord-post.ts:41`, `logging/redact.ts:95-106`). A crash between a 2xx and `markDelivered` can re-post once — at-least-once, accepted.
- CSV export decides its cap before streaming and yields per chunk (`usage-read/export.ts:119-133`).
- Quota floor clears with an optimistic `expected` revision (`quota-floor.ts:92-97`) — prior 102/09.2 is fixed.

## Doc claims falsified
- `docs/idea/08-observability.md:124` says "a response never says which cache TTL was written"; the Anthropic usage object reports `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` (see 07.8; unverified against a live response).
- `docs/idea/08-observability.md:73-75` says a refused batch "is held and retried … rather than deleted on the spot" to cover "a failover, a restart"; `recorder.ts:151` deletes it on the second refusal, one flush interval later, which a restart or failover outlasts (07.4).
- `apps/api/src/scheduler/types.ts:47-50` (comment) says an absent `startupDelayMs` means one full jittered interval; `runner.ts:210-215` uses `max(0, interval − age of last run)`, and `jitter(0)` is 1 ms (`runner.ts:65-68`), so every overdue task on every replica fires in the same millisecond after a restart.

## Steps
1. 07.2: group series points once in `usage-read/summary-view.ts`; adapt `buckets.ts`. One commit.
2. 07.1: rewrite the framing scanner (`response-framing.ts`), plain-object guard (`response-usage.ts`), `pushChunk` in `response-salvage.ts`, event-name/byte prefilter; add the bench leg. One commit; coordinate the optional descriptor field with the providers slice.
3. 07.4: transient classification + bisect in `recorder.ts` / `usage/fromEnv.ts`; update the existing discard test; update `docs/idea/08-observability.md:73-85`. One commit.
4. 07.5 + 07.10 + 07.9: runner deadline, defended `onTick`, throttled maintenance (`runner.ts`, `fromEnv.ts`, `types.ts`); env key via config slice; docs `01-architecture.md`, `09-deployment.md`. One commit.
5. 07.6: persisted ladder — schema/repo from auditor 08 first, then `exhausted-retest.ts`. One commit.
6. 07.7: single-flight in `usage-read/service.ts`; hand the `GROUPING SETS` consolidation to auditor 08.
7. 07.8: confirm the field from a redacted capture, then tokens/rates/estimate change and the doc fix.
8. 07.3, 07.11, 07.12, 07.13 as small follow-up commits.
9. `CHANGELOG.md` + version bump in the same PR as each behaviour change.

## Tests
- Extend: `apps/api/test/unit/usage/{response-framing,response-usage,response-salvage-parity,response-passthrough,recorder,usage-read,history-summary,filter}.test.ts`, `apps/api/test/unit/scheduler/{runner,orphan-runs,exhausted-retest,model-catalog-refresh}.test.ts`, `apps/api/test/unit/cost/{estimate,price-book,lookup}.test.ts`.
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end. Never a bare root `bun test`, never `bin/check` per slice.

## Done when
- Observer bench: SSE ≤ 10 ns/byte and non-stream JSON ≤ 0.3 ms per 16 KB chunk on the reference host, parity tests green.
- 100 groups × 400 buckets labels in < 5 ms per dimension.
- A writer refusing transiently for 30 flushes loses zero records below the queue ceiling; one poison row costs one record.
- A never-settling task is recorded `failed` at its deadline and other tasks keep running on a one-connection lock pool.
- Two task instances sharing a store produce one re-test ladder.
- Two concurrent identical summaries issue one set of queries.
- Docs at `08-observability.md:73-85,124` match the code.

## Not covered
- `apps/api/src/services/usage/response-salvage-canonical.ts`, `response-salvage-slots.ts`, `response-salvage-number.ts`: benchmarked through the observer, not read line by line.
- `scheduler/tasks/idle-account-probe.ts`, `idle-account-warmth.ts`, `config-dir-reap.ts`, `sdk-transcript-sweep.ts`: grepped for abort/timeout handling only.
- `usage-report/builder.ts`, `discord-render.ts`, `measures.ts`, `caveats.ts`, `overflow.ts`, `report-csv.ts`, `payload-schema.ts`, `period.ts`; vendor price tables other than the top of `tables/anthropic.ts` (no rate was checked against a vendor page).
- Whether each scheduler port (`testNow`, `usageGaugeProbe`, `refreshAccountCatalog`, `readPlanQuota`) bounds its own await — outside this area; 07.5's trigger depends on it.
- How quickly the Postgres driver rejects during an outage (07.4 timing) — reasoned, not run.
- Tests were skimmed by filename only; no test was found encoding a wrong rule other than the recorder "one retry" case named in 07.4. No full suite was run; three throwaway benches were (scratch dir, not in the repo).
