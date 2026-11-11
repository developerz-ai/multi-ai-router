# 10 — Production evidence

> Part of [`overview.md`](overview.md). Depends on: none. Owns: nothing in this repo directly — each finding names the slice that owns its fix, plus ../infrastructure/stacks/apps/multi-ai-router/

**Evidence window.** Pulled 2026-11-11 00:55–01:15 UTC, read-only. Pod `multi-ai-router-779698c5bf-pmdtz` (worker-2, image `2.55.0`, revision `4b47af8`, started 2026-11-09T11:33:00Z, 0 restarts). Logs: the pod's whole life from Loki, 147 721 lines, 2026-11-09T11:33:01Z → 2026-11-11T01:04:23Z (37.5 h); Loki holds 30 d and was also searched 14 d back for `needs_reauth`. Metrics: in-cluster Prometheus (`job=multi-ai-router`), 24 h and 7 d ranges. Database `multi_ai_router` on CNPG `postgres-1`, PostgreSQL 18.6; `pg_stat_statements` reset 2026-10-06 12:37 UTC and table counters cover the same ~35.5 d (usage_records `n_tup_ins` 395 281 = rows since 10-06). `4fantasia-router` is a different product (Rust gateway, image `4fantasia-router`, `stacks/apps/4fantasia/manifests/deployment-router.yml:1`) — not covered.

**Access recipe.** From `../infrastructure`: `kubectl()` in `scripts/lib/k8s/kubectl.ts` (SSH to control-1). SQL: `kubectl exec -n postgres postgres-1 -c postgres -- psql -X -d multi_ai_router -c "SET default_transaction_read_only = on; SET statement_timeout = '15s';" -c "BEGIN READ ONLY;" -c "<sql>" -c "ROLLBACK;"`. Loki: `kubectl get --raw "/api/v1/namespaces/observability/services/loki:3100/proxy/loki/api/v1/query_range?query=…"` (5 000 lines per page, page forward on the last timestamp). Prometheus: the API-server proxy returns 502, so `kubectl exec -n observability <grafana pod> -c grafana -- wget -qO- "http://kube-prometheus-stack-prometheus.observability.svc:9090/api/v1/query?query=…"`. Caveat for the next sweep: a wrapper that calls `process.exit` right after writing stdout truncates large outputs (cost this sweep one false "log is only 1 031 lines").

## Baseline numbers

| Measure | Value |
|---|---|
| Versions | pod 2.55.0 = repo 2.55.0 = remote infra `main` pin (`deployment.yml:634`); Argo Synced + Healthy; 44/44 migrations |
| Pod | 1 replica, Recreate, 0 restarts, no OOM (`memory.events` all 0); bun RSS 191 MB (HWM 322 MB), cgroup now 252 MB, peak 894 MB; requests 100m / 1Gi, limit 12Gi; CPU avg 67–75m, 5-min max 197m |
| Memory trend | bun RSS hourly minimum 97 → 116 → 114 → 123 → 127 → 121 → 124 MB across 36 h — flat |
| Processes | 3 (tini, bun, the exec shell); `pids.peak` 122; max concurrent SDK subprocesses 8, queue depth max 5 |
| Traffic, 24 h | 51 819 requests (Prometheus); 7 d: 183 360 |
| Terminal mix, 7 d | 141 365 × 200 · 41 349 × 429 router-made · 1 158 × 400 · 124 × 402 · 181 cancelled · 54 × 404 · 29 × 503 overloaded · 18 × 504 · 13 × 502 auth · 5 × 503 no-account |
| Attempts per request, 7 d | 1: 184 274 · 2: 132 · 3: 22 · 4: 16 |
| `router_overhead_ms`, 7 d (p50 / p95 / p99) | passthrough opencode-go 8 / 21 / 38 · passthrough minimax 13 / 47 / 76 · translate openai-oauth 13 / 39 / 60 · agent-sdk label 10 / 28 / 39 · pre-dispatch openai-chat 4 / 6 / 11 · pre-dispatch anthropic 7 / 4 023 / 5 014 |
| `router_overhead_seconds`, 24 h, all paths | p50 11.0 ms · p95 41.6 ms · p99 48.9 ms |
| Usage flush (`router_usage_admission_seconds`), 24 h | 37 295 flushes, p50 32 ms, p99 95 ms, 21 between 0.5–5 s, 15 over 5 s |
| DB size | 1 234 MB (was 126 MB on 10-02) |
| Tables | usage_contributions 1.11 M rows / 840 MB · usage_records 708 k / 276 MB · usage_request_terminals 401 k / 100 MB · scheduled_task_runs 30 k / 6.3 MB · everything else < 1 MB |
| usage_records per day | 11-10: 52 032 · 11-09: 55 129 · 11-03…11-07: 14–29 k · mid-October: 5–25 k |
| Statements since 10-06 | 18.87 M calls, 4 386 s total. Top by time: backfill anti-join 1 212 s (846 calls) · recovery poll 395 s (12.05 M calls) · history-lock `FOR UPDATE` 314 s · contributions insert 493 s · stale-run lookup 171 s |
| DB health | hit ratio 97.3 % · 0 deadlocks · 105 rollbacks / 14.65 M commits · 155 temp files (2.1 GB) · 5 idle postgres.js backends, none idle-in-transaction · no advisory lock held at snapshot |
| Postgres cluster | 1 instance, healthy, PVC 39 % of 103 GB, WAL 621 MB, daily backups 11-03…11-10 all completed, no failed backup |
| Logs | 110 771 info · 36 932 warn · 18 error; avg 3 787 lines/h, max 8 657 |
| Accounts | 18: anthropic-oauth 2 active + 5 needs_reauth · openai-oauth 1 · opencode-go 3 active + 1 disabled · openrouter 2 active + 1 exhausted · kimi 1 exhausted · zai 1 · minimax 1 |

## Findings

### 10.1 high — Kimi's weekly-window 429 is classified `credits-exhausted`: account parked `exhausted`, client gets 402
- **Kind:** nn-violation (NN 7)
- **Where:** `apps/api/src/providers/drivers/kimi.ts:30` and `:155` (owner: slice 04 providers).
- **Defect:** `typeRule("credits-exhausted", …, ["exceeded_current_quota_error"])` fires first, but Kimi now sends that `error.type` on a 429 whose text is "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends…" — a clock-recoverable window.
- **Failure scenario:** kimi `80dfa451`: 5 × `upstream attempt failed` (status 429, `failureKind=credits-exhausted`, `signal=kimi:exceeded_current_quota_error`) → 5 × `account parked by the router status=exhausted` (11-09 19:04, 23:12; 11-10 03:20, 04:22, 12:38) → 28 × 402 `CreditsExhaustedError … needs a top-up, no timer will fix it` on `/v1/messages`. Meanwhile `quota_windows` for the same account reads `seven_day utilization=1.000, resets_at=2026-11-12 14:31, reset_source=provider-reported`. The bounded re-test then flaps it: 4 re-tests pass, the next real request re-parks it.
- **Fix:** in `kimi.ts`, put a message rule for the weekly/window phrasing (`rate-limited`, with the reset from the plan-quota reading or `LONG_WINDOW_RETEST_SECONDS`) ahead of the type rule; keep `credits-exhausted` for the balance wording (`INSUFFICIENT_BALANCE`). Update the provenance comment at `:24-29` and `docs/idea/03-providers.md`.
- **Test:** unit — that 429 body → `rate-limited`, never `credits-exhausted`; integration — mocked Kimi 429 with that body → client 429 + `Retry-After`, `UsageRecord.outcome=quota_exhausted`, account not `exhausted`.
- **Re-run:** `select left(account_id::text,8), "window", utilization, resets_at, reset_source from quota_windows where account_id::text like '80dfa451%';` and Loki `{namespace="multi-ai-router"} |= "kimi:exceeded_current_quota_error"`.

### 10.2 high — Router overhead is 8–13 ms p50 and 38–82 ms p99 on the non-SDK paths, and grows linearly with prompt size
- **Kind:** nn-violation (NN 8) / perf
- **Where:** `usage_records.router_overhead_ms` (`apps/api/src/services/dataplane/records.ts:157-159`), `router_overhead_seconds`; the work itself is somewhere in `apps/api/src/services/dataplane/` (owner: slice 02; slice 06 for the translate share).
- **Defect:** body-read wait is already subtracted (`records.ts:159`, the 10-02 fix), yet the remaining router time scales with body size — per-request work proportional to the prompt on a path that must not parse a passthrough body.
- **Failure scenario:** successes, last 3 d, by input tokens (in + cache read + cache write), p50 / p95 / p99 ms. Passthrough: < 5 k → 1 / 2 / 4 · 5–20 k → 3 / 5 / 7 · 20–50 k → 6 / 9 / 12 · 50–100 k → 10 / 16 / 19 · 100–200 k → 18 / 26 / 30 · > 200 k → 28 / 35 / 39. Translate: 3 / 6 / 11 / 18 / 30 / 51 p50 over the same buckets, p99 up to 88. Rows labelled `agent-sdk` (fast mode is on, so these are direct HTTP): 2 / 3 / 8 / 15 / 25 / 41. Roughly 0.15–0.25 ms per 1 000 tokens everywhere. Worst hour p99 64 ms (11-10 01:00). The 10-02 `bin/bench` 280 KB case measured passthrough p99 5.0 ms, so prod is 4–8× the bench at the same size.
- **Fix:** profile a 400 KB same-dialect request end to end in `bin/bench` with prod-shaped bodies (many messages, tool schemas, cache-control blocks) and remove whatever is O(body): candidates to check, none confirmed here — a full `JSON.parse` for model/session sniffing, token estimation, session-key hashing over the body, chunk concatenation between read waits (JS time between chunks is not in `bodyReadMs`). Separately decide whether fast-mode rows keep the `agent-sdk` exemption label (`plan.ts:84`), since they are plain HTTP.
- **Test:** `bin/bench --prompt-bytes 400000` asserting passthrough p99 < 5 ms; unit on the body scanner with a 400 KB fixture.
- **Re-run:** `select egress_mode, width_bucket(coalesce(tokens_in,0)+coalesce(cache_read_tokens,0)+coalesce(cache_write_tokens,0), array[1000,5000,20000,50000,100000,200000]) b, count(*), percentile_disc(0.5) within group (order by router_overhead_ms), percentile_disc(0.99) within group (order by router_overhead_ms) from usage_records where created_at > now() - interval '3 days' and outcome='success' group by 1,2 order by 1,2;`

- **After 2.57.0** (developerz-ai, 2026-11-11 06:56–08:00Z, successes, same buckets, p50 / p99 ms):
  - Translate: 2 / 9 · 5 / 8 · 9 / 17 · 16 / 27 · 23 / 29 · 30 / 45.
  - Passthrough: 7 / 8 · 4 / 4 · 5 / 6 (n ≤ 7 per bucket).
  - All paths together: translate p50 / p99 16 / 31 (pre-sweep 13 / 42); passthrough 5 / 8 (pre-sweep 5 / 17).
  - The passthrough O(body) work is gone: what is left is the body skim. Translate is still linear.
  - Measured `bodyFor` on a 1 MB prod-shaped transcript: decode 0.21, JSON.parse 1.47, Zod 0.83, convert 1.00, stringify 1.18, encode 0.14, about 5 ms in total. No redundant pass.
  - The remaining cost is inherent to a stateless translator that is resent the whole transcript every turn. A per-session prefix cache needs a spec decision first and is tracked in #388.

### 10.3 medium — An upstream-supplied OpenRouter key hash is written to the log
- **Kind:** nn-violation (NN 3) — `unverified` whether the project counts a provider key hash as credential material
- **Where:** log line `account test failed`, field `detail` (component `test-now`); redactor in `apps/api/src/logging/redact` (owner: slice 01), probe message plumbing in slice 03.
- **Defect:** OpenRouter's "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/<64 hex chars>" is logged verbatim; the 64-hex segment is the provider's identifier for the account's API key (a hash of it), and nothing scrubs it.
- **Failure scenario:** 5 lines in 37.5 h for openrouter `3f4d48ef`, shipped to Loki (30 d retention, readable by anyone with Grafana). The same text is likely shown by the admin "Re-check now" result and stored in `audit_events.detail` for `account.tested` — not checked.
- **Fix:** scrub provider key-management URLs / long hex path segments in `redactValue`, or truncate upstream text at the first URL for this signal (`openrouter:key-limit`). Add the shape to the redaction test corpus.
- **Test:** unit on the redactor with that message; integration asserting no 64-hex run in the log line or admin response.
- **Re-run:** Loki `{namespace="multi-ai-router"} |= "account test failed" |= "openrouter"` — inspect shape only.

### 10.4 high — Since 2.55.0, structured-output requests to Claude subscriptions hang 180 s and then fail 400
- **Kind:** bug (regression candidate, commit `4b47af8`)
- **Where:** native `response_format` → `output_config.format.schema` for Claude subs; `apps/api/src/services/translate/shared/structured-output.ts` and the claude-fast request builder (owner: slices 05 / 06).
- **Defect:** client JSON schemas are forwarded as-is to Anthropic's constrained output, which rejects them — after a 180 s grammar compile — and the router relays the 400 with no fallback.
- **Failure scenario:** 37.5 h of logs, `upstream attempt failed` with `signal=claude-sdk:api-status-400`: 46 × "Schema is too complex." (request duration 180.2–182.4 s each), 2 × "Grammar compilation timed out" (180.3 s), 13 × "output_config.format.schema: For 'array' type, property 'maxItems' is not supported" (0.13–0.2 s). Per day, anthropic-oauth 400s: 5 / 6 / 17 on 11-06…11-08 averaging 134–363 ms, then 65 on 11-09 averaging 116.6 s and 18 on 11-10 averaging 166.2 s. `/v1/chat/completions` 400 p95 in the request log is 180.3 s.
- **Fix:** strip keywords the target refuses (`maxItems`, and whatever else the Anthropic schema subset excludes) with a `translation dropped fields` line; on a schema-rejection 400 from the native path, retry once on the pre-2.55 adaptation instead of relaying; bound the wait so a 180 s compile cannot hold a client. Update `docs/idea/claude-fast-mode.md`.
- **Test:** unit — schema with `maxItems` → sanitized; integration — mocked upstream answering 400 "Schema is too complex." → request served via the fallback, one `UsageRecord` per attempt.
- **Re-run:** `select created_at::date, count(*) filter (where outcome='client_error' and http_status=400), round(avg(latency_ms) filter (where outcome='client_error' and http_status=400)) from usage_records where provider::text='anthropic-oauth' and created_at > now() - interval '9 days' group by 1 order by 1;`
- **Related, lower:** openai-oauth relayed 126 × 400 "Invalid schema for response_format 'response': … 'required' is required to be supplied and to be an array including every key in properties" on 11-10 (104 on 11-05). Those fail in ~0.5 s and `strict` is passed through as the client sent it (`structured-output.ts:15`), so this looks client-side; confirm the router does not add `strict: true`.

### 10.5 high — The hourly usage backfill sweep is a full-table anti-join held under the lock that serializes every usage write
- **Kind:** db
- **Where:** `packages/db/src/repositories/usage-history-maintenance.ts:32-45` (`cursor` starts `undefined`, so each sweep scans from the first row) and `usage-history-lock.ts:6-18` (owner: slices 08 / 07).
- **Defect:** every `usage_rollup` run walks all of `usage_records` by `created_at` with a nested-loop probe into `usage_contributions` to find rows without a contribution; there have been none (0 of 707 973), so it always reads the whole table, while holding `usage_history_state … FOR UPDATE`.
- **Failure scenario:** the two normalized forms of that select: 203 calls mean 3 102 ms, max 8 641 ms; 643 calls mean 906 ms, max 2 933 ms — 1 212 s, 28 % of all database time since 10-06, and the source of 291 M scans on `usage_contributions_kind_id_pk`. `usage_rollup`: 336 runs in 14 d, 0 items processed, avg 2.49 s, max 8.7 s. Usage flushes queue behind it: the lock's `FOR UPDATE` has max 8 134 ms, and 15 flushes in 24 h took over 5 s. Cost is linear in retained rows (90 d); at the current ~50 k rows/day the table reaches ~4.5 M rows and the scan passes the 15 s `statement_timeout`, after which the rollup fails every hour.
- **Fix:** start the scan at the persisted `banked_through_(at, id)` watermark (already maintained at `:18-27`) instead of the table start, keeping a rare full verification pass off the lock; or retire the sweep now that every writer banks in-transaction. Take the history lock only around the write, not the read. Update `docs/idea/08-observability.md`.
- **Test:** repository test — with the watermark at the newest row, the sweep reads zero `usage_records` pages (assert via `EXPLAIN` row estimate or a row-count spy) and still adopts a row inserted below the watermark by the legacy path if that case is kept.
- **Re-run:** `explain select id from usage_records where not exists (select 1 from usage_contributions c where c.kind='attempt' and c.id=usage_records.id and c.source <> 'legacy_pending') order by created_at, id limit 500;` and `select calls, mean_exec_time, max_exec_time from pg_stat_statements where queryid in (2700373073197902959, 1834337104264002463);`

### 10.6 medium — A single client retry loop makes 22 % of all usage rows; nothing damps repeated pre-dispatch rejections
- **Kind:** perf / db
- **Where:** pre-dispatch rejection path `apps/api/src/services/dataplane/request-accounting.ts:134-170` and the usage recorder (owner: slices 02 / 07).
- **Defect:** every router-made 429 costs a full usage write (1 `usage_records` + 1 `usage_request_terminals` + 2 `usage_contributions` rows, about 12 statements) and two log lines, with no coalescing for an identical request repeated by a client that ignores the reset.
- **Failure scenario:** key `e69a0620`, one session, one 94 089-byte `/v1/chat/completions` body for `glm-5.3-flash`: 30 924 identical requests in 31 h, median 16 per minute, max 47, each answered 429 naming an earliest reset of 2026-11-16T00:00Z (5 days out). 7 d: 41 349 router-made 429s of 184 444 terminals; 24 h: 23 067 `quota_exhausted` of 51 819 requests. The 429s are legitimate — both in-scope seats report a spent weekly window, the third is credential-rejected, the fourth disabled.
- **Fix:** confirm the response carries `Retry-After` for the 5-day reset (not visible in logs); then collapse repeated identical pre-dispatch rejections per (key, session, model, error) into one usage row with a count per flush window, and log them at a sampled rate. A per-key rejection rate limit is the alternative. Document in `docs/idea/08-observability.md`.
- **Test:** integration — 100 identical rejected requests in one flush window → bounded usage rows whose counts sum to 100; `Retry-After` asserted on the response.
- **Re-run:** `select outcome, response_status, error_class, count(*) from usage_request_terminals where settled_at > now() - interval '7 days' group by 1,2,3 order by 4 desc;`

### 10.7 medium — An opencode-go entitlement 403 is treated as a rejected credential and re-probed with live client requests
- **Kind:** bug
- **Where:** opencode-go driver rules in `apps/api/src/providers/drivers/` and the recovery probe `apps/api/src/services/dataplane/recovery-probe.ts:153` (owner: slices 04 / 03).
- **Defect:** "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models." (also "This API key belongs to the team…") is a plan-entitlement refusal no clock will fix, but it is classified `auth` → `credential rejected upstream, re-checked after <estimated>`, the account row stays `status=active`, and each re-check spends a real client request.
- **Failure scenario:** account `e2d54875`: 11 × upstream 403 in 37.5 h, about one every 4 h, each returned to the client as 502 `UpstreamAuthError` while the other seats were cooling (13 such error-level lines for key `e69a0620` in total, two of them from the seat `0c688ac8` before it was disabled); 161 × `router recovery probe declined at admission`; `account_recoveries.state=uncertain`; Prometheus `RouterCredentialRejected` firing. The disabled seat `0c688ac8` shows the same 403 and still sits `half-open` with 37 declined probes.
- **Fix:** one driver rule mapping that text to a human-needed state (needs_reauth or a "not entitled" reason) with no automatic re-test; recovery probing must skip disabled accounts; a probe that fails on an account-level refusal should fall through to the 429 the rest of the pool earned rather than a 502. Update `docs/idea/03-providers.md`.
- **Test:** unit — that 403 body → non-retestable verdict; integration — pool of two cooling seats plus one such seat → client gets 429 + `Retry-After`, never 502.

### 10.8 medium — `cooldown_recheck` reopens seats whose provider-reported weekly window is still fully spent
- **Kind:** bug — mechanism `unverified`
- **Where:** `apps/api/src/scheduler/tasks/cooldown-recheck.ts:192-217` (`byRequest` → `recordSuccess` on any 2xx) (owner: slices 07 / 03).
- **Defect:** a successful probe request reopens the account even when its own plan-quota reading says the window is at 1.0 until a provider-reported reset days away.
- **Failure scenario:** opencode-go `589105ca` and `ae852ac0`: `seven_day utilization=1.000, resets_at=2026-11-16 00:00, provider-reported, blocks_routing=t`; `account rechecked on cooldown verdict=reopened` 26 and 25 times in 37.5 h; each reopening is followed by real requests failing upstream — 53 × "Go usage limit exceeded" and 18 × "OpenCode Go usage limit reached" (429) — then the seat cools again. Likely the probe model is not the one the limit applies to.
- **Fix:** do not reopen while a current, provider-reported window for the account is at or above `quotaSpentThreshold` with a future reset; or probe with the model that tripped the cooldown. Document the rule in `docs/idea/04-routing.md`.
- **Test:** unit on the recheck with an injected snapshot: spent provider-reported window + 2xx probe → `still-cooling`.

### 10.9 medium — The recovery coordinator queries Postgres every 250 ms, forever
- **Kind:** db
- **Where:** `apps/api/src/services/recovery/coordinator.ts:145-148` (`listExpiredIssued` on every tick), interval `apps/api/src/config/recovery.ts:31` (owner: slice 03).
- **Defect:** the expired-permit lookup runs unconditionally each tick even when this boot has issued nothing.
- **Failure scenario:** 12.05 M calls since 10-06 (3.9 per second), 64 % of all statements, 395 s of execution, 344 rows ever returned; 12.5 M sequential scans of the 17-row `account_recoveries`. One pooled connection is busy about 4 times a second for nothing, and the noise hides real statements in `pg_stat_statements`.
- **Fix:** run the expiry lookup on its own slower cadence (a fraction of `maximumOutcomeMs`) or only while a permit is outstanding / demanded; keep the 250 ms tick for in-memory queues.
- **Test:** unit with a fake repository — 100 idle ticks → at most one `listExpiredIssued` call per configured expiry interval.
- **Re-run:** `select calls, rows, total_exec_time from pg_stat_statements where queryid in (3905676896118682299, -6278181803833426939);`

### 10.10 medium — At each Claude access-token expiry, concurrent requests stall up to 20 s and the refresh wait times out
- **Kind:** bug / perf
- **Where:** `apps/api/src/providers/claude-sdk/credential-freshness.ts:233` and `:370` (owner: slice 05).
- **Defect:** when a busy subscription enters the CLI's refresh window, the first waiter always burns the whole 20 s budget ("claude credential refresh did not land; proceeding anyway") and the requests queued behind it wait most of it.
- **Failure scenario:** account `1b0e2af1`, every ~8 h (11-09 12:37, 20:32; 11-10 04:28, 12:23, 20:20) plus `afbee92b` once: 7 of 7 cycles logged "did not land" with `waitedMs` 20 008–20 250; 5–13 requests per cycle logged "window entered"; observed waits for the others 0.25–19.9 s. That is the largest regular time-to-first-token spike in the window.
- **Fix:** find why the turn that should let the CLI refresh does not complete inside the budget on a busy account (the keepalive only covers idle ones); let the first request proceed through the SDK path immediately and release waiters when the token timestamp moves, rather than timing out. Update `docs/idea/claude-fast-mode.md`.
- **Test:** unit with an injected clock — token enters the refresh lead with 10 concurrent requests → at most one pays the refresh, none waits the full budget.

### 10.11 medium — The usage page runs about 20 aggregates over raw `usage_records` per load
- **Kind:** db
- **Where:** `packages/db/src/repositories/usage-read-repository.ts` and neighbours (`usage-recent-repository.ts`, `usage-week-read.ts`) (owner: slices 08 / 07 / 09).
- **Defect:** per-dimension group-bys (model, key, pool, account, two `grp` forms) with `count(distinct correlation_id)`, a `percentile_disc` query and about a dozen `with facts as …` variants each scan the whole window.
- **Failure scenario:** 102 page loads since 10-06; each query averages 240–375 ms and peaks at 0.4–1.3 s; a 7-day window is 184 642 rows and 113 650 buffer hits per query (`EXPLAIN (ANALYZE, BUFFERS)`: 490 ms for the model group-by, 138 ms for the percentiles). At 50 k rows/day a 30-day window is about 1.5 M rows per query, several seconds each, 20 times per load.
- **Fix:** serve closed days from `usage_attempt_daily_v2` / `usage_request_daily_v2` (already maintained, 716 / 700 rows) and scan raw rows only for today; compute the dimensions from one pass (grouping sets) instead of one query each.
- **Test:** repository test comparing rollup-backed totals to raw totals over a seeded multi-day fixture.

### 10.12 medium — `usage_contributions` is 68 % of the database and has a two-year horizon
- **Kind:** db
- **Where:** `packages/db/src/schema/usage-contributions.ts`, retention in `usage_history_state.retention_before_day` (owner: slices 08 / 07).
- **Defect:** every request stores two JSON payload rows (attempt + terminal, about 500 bytes of payload each, about 755 bytes per row with indexes) in addition to `usage_records` and `usage_request_terminals`, and they are kept until `retention_before_day` (currently 2024-11-11, i.e. two years).
- **Failure scenario:** 1.11 M rows, 840 MB after five weeks of the new pipeline; the database grew from 126 MB to 1 234 MB since 10-02. At the last two days' rate (about 105 k contribution rows/day) that is roughly 80 MB/day, 29 GB/year. A quarter of the live rows come from the retry loop in 10.6. The Postgres PVC is 103 GB shared with 25 GB of other databases.
- **Fix:** decide what the receipts are for once a day is rolled up: drop payloads for banked days, or shorten the horizon via config (NN 11). `usage_contributions_source_idx` (58 MB, 507 scans) is a second candidate.
- **Test:** janitor test — contributions older than the configured horizon are purged in bounded batches and rollups stay unchanged.

### 10.13 low — `accounts_last_used_at_idx` is never read and makes every last-used stamp a non-HOT update
- **Kind:** db
- **Where:** migration `packages/db/migrations/0016_account_last_used_at.sql`, `packages/db/src/schema/accounts.ts` (owner: slice 08).
- **Defect:** the index has 0 scans, and because `last_used_at` is indexed, the per-flush `update accounts set last_used_at …` cannot be HOT.
- **Failure scenario:** 306 422 updates on an 18-row table, 37 HOT; 4 869 autovacuum runs on `accounts`. Other indexes with 0–2 scans since 10-06: `usage_records_correlation_idx` (29 MB, 2 scans), `usage_records_client_request_idx` (2), `accounts_status_idx` (0), `api_key_pools_pool_idx` (0), `model_catalog_model_id_idx` (1), `usage_daily_account_day_idx` (0), `oauth_states_expires_at_idx` (0).
- **Fix:** drop `accounts_last_used_at_idx`; review the others — `usage_records_correlation_idx` is the only one with real write cost.
- **Test:** migration test; nothing behavioural.

### 10.14 low — The stale-run lookup reads the whole task history on every scheduler start
- **Kind:** db
- **Where:** `packages/db/src/repositories/scheduled-task-repository.ts` (query `where task = $1 and finished_at is null and started_at < $2`) (owner: slice 08).
- **Defect:** it uses `scheduled_task_runs_task_started_idx` and filters `finished_at is null` on the heap, so each call reads every past run of the task.
- **Failure scenario:** 35 517 calls, mean 4.3–6.3 ms, 171 s total, 239 M index tuples read (about 6 700 per call) to return 0 rows.
- **Fix:** partial index `(task, started_at) where finished_at is null`.
- **Test:** none beyond the migration.

### 10.15 low — Log volume is dominated by lines that carry no new information
- **Kind:** structure
- **Where:** transport request logging and `sdk session plan` (owner: slice 01; slice 05 for the plan line).
- **Defect:** a failed request logs both `request failed` and `request completed`; `sdk session plan` logs at info for every Claude request with the same content; `/metrics` scrapes and the uptime probe are request-logged; one tool-schema drop is warned once per request.
- **Failure scenario:** of 147 721 lines: 35 224 `request failed` duplicated by a `request completed` (30 MB of 62 MB); 19 951 `sdk session plan`, all `plan=fresh, reason=no-session`; 7 814 `GET /metrics` and 3 908 `GET /`; 1 001 identical `translation dropped fields` warnings for one tool's regex.
- **Fix:** one line per request (fold the failure fields into the completion line); `sdk session plan` at debug or only when not `fresh`; skip request logs for `/metrics`; rate-limit identical translation warnings per key and field.
- **Test:** integration — a rejected request emits exactly one transport line.

### 10.16 low — A delisted OpenRouter model keeps being routed
- **Kind:** bug
- **Where:** model catalog / `supported_models` for openrouter (owner: slice 04).
- **Defect:** `inception/mercury-2` is still treated as served by account `ba5b860e` although the provider answers 404 "is no longer available on OpenRouter".
- **Failure scenario:** 40 × 404 in 37.5 h (54 in 7 d), each a client-visible 404 after an upstream round trip.
- **Fix:** on that 404, drop the model from the account's served set until the next successful catalog refresh; check why `model_catalog_refresh` did not remove it.
- **Test:** integration — mocked 404 with that body → model removed from the account's catalog rows.

### 10.17 low — Codex mid-stream failures are recorded with no message
- **Kind:** bug
- **Where:** `upstream stream failure` for openai-oauth (owner: slice 04).
- **Defect:** 41 of 45 lines for account `1cac6263` carry `errorClass=upstream_error` and `upstreamMessage=null`.
- **Failure scenario:** 77 `upstream_error` terminals with response 200 in 7 d (0.23 % of that account's requests) that cannot be diagnosed from logs.
- **Fix:** capture the terminating event type or socket error at the point the stream breaks.
- **Test:** integration — upstream closes mid-stream → log line and `UsageRecord.error_class` name the cause.

### 10.18 low — Deploys cut live streams
- **Kind:** bug (infra + app)
- **Where:** `../infrastructure/stacks/apps/multi-ai-router/manifests/configmap.yml` (`SHUTDOWN_DRAIN_MS: "20000"`), Recreate strategy.
- **Defect:** the drain is 20 s while stream p99 is 74–131 s.
- **Failure scenario:** 27 `router_shutdown` attempts in 7 d; 23 deployment generations and 39 pods in 30 d.
- **Fix:** raise the drain and `terminationGracePeriodSeconds` toward the stream p99, or batch releases.

### 10.19 low — Infra README still says admin sessions are in memory
- **Kind:** docs
- **Where:** `../infrastructure/stacks/apps/multi-ai-router/README.md:30` on remote `main` (carried over from 102/13.1, still open).
- **Defect:** sessions are in Postgres (`admin_sessions`, 3 rows live). The local infra checkout is also stale (pins 2.52.1; remote and live are 2.55.0) — sync before editing.

### 10.20 low — Legacy tables are still queried, and usage rows outlive their accounts without a tombstone
- **Kind:** db
- **Where:** `packages/db/src/schema/usage-daily.ts`, `sessions.ts` (owner: slice 08).
- **Defect:** `usage_daily` (291 rows, no writes since 10-06) is still read (10 053 index scans, and inside the usage-bounds query); `sessions` has 0 rows and 1 354 scans. 9 588 `usage_records` rows reference deleted accounts and 7 reference deleted keys (keys have `api_key_tombstones`; accounts have nothing).
- **Fix:** retire the legacy reads once the v2 rollups are the source; add an account tombstone or keep the label on delete so reports can name the account.

### 10.21 low — "No account serves this model" is a 503 logged at error
- **Kind:** bug — `unverified` against the spec's intended code
- **Where:** `apps/api/src/services/routing/no-candidates.ts:132` (owner: slice 03).
- **Defect:** the message itself calls it "a client change", but the status is 503 `NoHealthyAccountError`, which invites retries and pages as a server error.
- **Failure scenario:** 5 in 37.5 h (`gpt-6.1-sol` on the opencode-go pool, `qwen3.7-plus` on a one-account key).
- **Fix:** a 4xx with a model-not-served class, logged at warn; update `docs/idea/04-routing.md`.

## Checked, not a bug
- Five Claude subscriptions in `needs_reauth` since 11-01…11-05: each hit its ~28-day login lifetime (`claude subscription login renewal due` counted down from 3 days; last logins 10-06). The keepalive refreshed their access tokens every ~8 h until then. Operator action, not a router fault — but only two subs are live and they sit at 0.98 and 1.00 of the weekly window.
- `credential keepalive` logging `due=1, skipped=1` 183 times in a row: the due account (`afbee92b`) has a spent weekly window, and `composition/background-admission.ts:42-53` refuses a paid turn on it by design. It clears at the window reset.
- `accounts.status=active` while Prometheus `router_accounts` says `cooling_down` (3 opencode-go, 1 anthropic): effective health is in memory plus `quota_windows`, as ruled in 102/13.
- Router-made 429s were checked against state at the time: every sampled message lists all in-scope accounts as spent, rejected, disabled or not serving the model. No 429 with an eligible account found.
- Pre-dispatch anthropic rejections with p95 4 023 ms: 195 × `waiting for a recovery permit budgetMs=5000` — the deliberate wait-then-reroute, though it is counted into `router_overhead_ms`.
- `http_status` NULL on 41 687 rows: pre-dispatch rejections; `response_status` now carries the client status (NULL on only 331 intermediate attempts).
- Usage inserts are one row per statement for 262 k of 294 k calls: the recorder batches (1 s flush, 200 rows), traffic is just under one request per second.
- Account labels (some are email addresses) appear in client-facing 429/402/503 messages and in 139 log lines: deliberate per `no-candidates.ts:14`. Worth an operator note that labels are visible to every key holder in scope.
- Catalog reload every 30 s (`CATALOG_REFRESH_SECONDS`) explains ~125 k scans each of `pools`, `pool_members`, `quota_windows` and ~102 k full reads of `model_catalog`; cheap at this size.
- `oauth_states`: 0 rows, purge runs every 5 min. `scheduled_task_runs` oldest row 10-12 (30-day retention working). `usage_records` oldest row 08-13 (90 days, janitor deleting).
- `GET /.git/HEAD`, `/config.json` returning 200: SPA fallback serving the shell to scanners.

## Healthy
- Versions aligned everywhere; Argo Synced + Healthy; no namespace events; no restarts, no OOM, no CPU throttling.
- Memory flat over 37 h; no leaked or zombie `claude` processes; `/data/claude` 94 MB across 8 directories, `/tmp` 8 KB.
- All 14 scheduler tasks ran inside their interval over 14 d; only 7 `model_catalog_refresh` and 1 `plan_quota_read` partials, no failures, no unfinished runs, no advisory lock stuck.
- Exhausted re-test follows the 2 h → 4 h → 8 h → 16 h doubling for both parked accounts, each with an alert line.
- DB pool: 12 connections, max 3 in use, 0 waiting. No idle-in-transaction, no deadlocks, no invalid indexes. Key lookup by prefix uses `api_keys_prefix_idx`.
- Token columns: no negatives, max 970 816 input tokens — far from int4 range.
- Cost basis: 4 `unknown` successes in 7 d (`gpt-reserve` × 2, `kimi-for-coding` × 2); the October gap is closed.
- Boot: migrations, runtime ready and listening within 2 s.
- Secret scan of all 147 721 lines for bearer tokens, `sk-`, router keys, `refresh_token`, JWT shapes and long base64 runs: only the hit in 10.3.
- Postgres backups daily and complete; blackbox probe success 99.83 % over 7 d.

## Doc claims falsified
- `../infrastructure/stacks/apps/multi-ai-router/README.md:30` says the admin session store is in memory; `admin_sessions` in Postgres holds them.
- `apps/api/src/providers/drivers/kimi.ts:24-29` says `exceeded_current_quota_error` is the drained-balance case; live Kimi sends it for the weekly window (10.1).
- CLAUDE.md NN 8 "<5 ms added p99": production p99 is 38–82 ms on passthrough and translate (10.2).

## Steps
1. 10.1 — Kimi rule order; ship alone, it is one file and a live NN 7 breach.
2. 10.4 — schema sanitizing and fallback for native structured output on Claude subs.
3. 10.5 + 10.14 + 10.13 — one db commit: watermark-driven backfill, partial index, drop the unused index.
4. 10.2 — profile with a 400 KB prod-shaped body, then fix what the profile names.
5. 10.7 + 10.8 + 10.9 — recovery and recheck behaviour (routing/health slice).
6. 10.6 + 10.15 — rejection coalescing and one log line per request.
7. 10.10, 10.11, 10.12, then the lows; 10.3 with the redactor work in slice 01.
8. `../infrastructure`: 10.18 drain, 10.19 README, sync the local checkout.
9. After release, re-pull the Baseline table over an equal window and diff.

## Tests
- Named per finding; owners add them in their slices. `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end. `bin/bench` with a large prompt for 10.2.

## Done when
- No `exhausted` park or 402 for a Kimi window limit over a week of logs.
- `router_overhead_ms` p99 under 5 ms for passthrough at every prompt-size bucket, from the 10.2 query.
- No Claude-sub 400 with latency over a few seconds; the backfill select's mean under 50 ms; recovery poll under 10 k calls/day.
- Router-made 429 share of `usage_request_terminals` reflects distinct rejections, not retries.

## Not covered
- GlitchTip events (no read path without new credentials). `kubectl describe pod` skipped so plain env values were never printed; env names only.
- Logs of earlier pods beyond the `needs_reauth` search; Loki's 30 d were not fully aggregated.
- `Retry-After` header values (not logged). Request bodies and prompts were never read, so 10.4's schemas and 10.6's payload are known by size and error text only.
- Index bloat estimates; `EXPLAIN` of the retention deletes and of the `with facts` usage queries (parameters unknown).
- Whether the OpenRouter key hash also lands in `audit_events.detail` or admin responses (10.3) — the column was not selected.
- A restore drill, PVC backup of `/data/claude`, and multi-replica behaviour.
