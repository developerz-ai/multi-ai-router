# 12 — Tesote deployment (second production)

> Part of [`overview.md`](overview.md). Depends on: none. Owns: nothing in this repo directly — each finding names its owner slice or a path in tesote/infrastructure (edited from its own repo).

**Evidence window.** Static: `tesote/infrastructure` at `origin/main` = `2f33c9d2` (the revision ArgoCD reports synced; the local working tree sits on a stale feature branch pinning v2.51.0, so every manifest claim below was read with `git show origin/main:<path>` or diffed against it). Live: pulled 2026-11-11 00:59–01:25 UTC through the repo's own read-only verbs — `bin/k8s/kubectl.sh` (get/top/exec df,du), `bun scripts/observability/query.ts prom|logs|alerts`, `bun scripts/db/sql.ts --db multi_ai_router` (every statement wrapped `SET default_transaction_read_only=on; SET statement_timeout='15s'; BEGIN READ ONLY; … ROLLBACK;`). Live access worked. Router `2.55.0` rev `4b47af8` (pod up since 2026-11-10 15:12Z, 0 restarts), Envoy `distroless-v1.39.4`, PostgreSQL 18.3 (pg-production, direct :5432). Logs: Loki `apps` tenant, 14 d queried (retention is longer; stack live since 2026-10-14). Metrics: Prometheus 14 d. DB: `usage_records` 2026-10-14 → now (297,533 rows); `pg_stat_statements` since 2026-05-13 (never reset). `tesote-monitoring` and `infra-followups` contain nothing about the router.

**Baseline numbers** (14 d unless stated)

| Metric | Value |
|---|---|
| Accounts | 3 — one each `openai-oauth`, `zai`, `openrouter`; 1 pool, 3 keys (all scope `accounts`), no Claude subscription, `/data/claude` empty |
| Requests (`usage_records`) | 200,579; ~14.8k/day; attempts: 200,576 first, 3 second (failover effectively never happens — no two accounts share a model) |
| Outcome mix | success 121,109 · router-made `429 quota_exhausted` 76,212 (38 %) · upstream zai `429` 1,935 · `client_cancelled` 859 · `503 request_admission_unavailable` 178 · `upstream_error` 179 · `upstream_timeout` 43 · `503 NoHealthyAccount` 30 · `router_shutdown` 21 |
| HTTP status (router log) | 200 165,215 · 429 77,977 · 503 377 · 499 114 · **500 62** · 404 32 · 504 8 |
| `router_overhead_ms`, success | anthropic→zai passthrough p50 2 / p95 14 / p99 2,504 · anthropic→openai-oauth translate 3 / 17 / 23 · openai-chat→openai-oauth translate 4 / 34 / 65 · openai-chat→openrouter passthrough 3 / 15 / 20 |
| `router_overhead_seconds` (Prom, 7 d) | translate: 89.7 % ≤ 5 ms, p99 ≈ 17 ms · passthrough: 91.3 % ≤ 5 ms, 4.9 % > 100 ms (top bucket), mean 77 ms |
| Pod | router 9 m CPU / 94 Mi now, 14 d max 177 Mi / 0.19 core (limit 12 Gi); Envoy max 79 Mi (limit 256 Mi); 0 restarts, 0 OOM; `router_sdk_subprocesses` max 0 |
| Rollouts | 18 boots in 14 d (19 pod IPs), each ≈ 62 s of outage; public probe availability 99.81 % |
| DB | 662 MB; `usage_contributions` 439 MB / 594,924 rows, `usage_records` 140 MB, `usage_request_terminals` 68 MB; 4 backends; 0 deadlocks; 44 migrations applied (= repo) |
| Scheduler | 0 unfinished runs, `router_task_consecutive_failures` all 0; `plan_quota_read` partial 384 / 415 runs |

## Findings

### 12.1 high — Non-stream answers slower than ~60 s are cut by the router and filed as `client_cancelled`
- **Kind:** bug (mechanism `unverified`, fingerprint confirmed)
- **Where:** owner 01 `apps/api/src/middleware/idleClock.ts:28-47` + 02 passthrough relay; contradicts `01-transport-auth-config.md:140` "Checked, not a bug".
- **Defect:** the 2.40.1 idle-clock hold works for the Codex translate path (0 no-byte cancels at 55–80 s) but not for anthropic→zai passthrough: the connection dies at the listener's 60 s clock with nothing written.
- **Failure scenario:** zai `glm-5.3-flash`, non-stream, 200 KB–1.3 MB body. Router logs `request completed status 200 durationMs 1,243–7,507`; Envoy logs the same `request_id` `502 flags=UPE bytes_out=87 duration_ms 58,495–110,129` (38 in 3 d, 38/38 matched); `usage_records` says `client_error / client_cancelled`, `ttfb_ms NULL`, `tokens_out 0`, latency ≈ 66 s. Envoy has no 60 s clock (`timeout: 0s`, `stream_idle_timeout: 600s`), so the client did not cancel. 14 d: 512 zai no-byte "cancels" in 55–80 s, 454 of them in 58–70 s, only 8 in 40–54 s. Clients resend the identical body (one 221,096-byte request 13× in 12 min, all cut).
- **Fix:** reproduce with a stub upstream that sends headers at 1 s and a non-SSE body at 70 s through the passthrough relay under `Bun.serve`; find why `server.timeout(request, 0)` is lost (response rewrap, content-type sniff, or relay returning a fresh `Response`). Classify a listener-clock cut as a router error, never `client_cancelled`. Update `docs/idea/09-deployment.md:135`.
- **Test:** integration, real `Bun.serve`, mocked upstream delaying a JSON body past `SERVER_IDLE_TIMEOUT_SECONDS` (set to 2 s) on passthrough and translate; assert 200 + `UsageRecord` `success`.
- **Re-run:** `bun scripts/observability/query.ts logs '{namespace="multi-ai-router",container="envoy"} |~ "UPE"' --since 3d --limit 60 --json`; SQL: `select width_bucket(latency_ms, array[56000,58000,60000,…]) b, count(*) from usage_records where error_class='client_cancelled' and ttfb_ms is null and provider='zai' and latency_ms between 40000 and 100000 group by 1`.

### 12.2 high — Shutdown closes request admission before the readiness grace; the grace is 20 s of guaranteed `503`
- **Kind:** bug + docs
- **Where:** owner 01 `apps/api/src/main.ts:126-128` (phase `admission` precedes `readiness-grace`), `apps/api/src/services/shutdown/transport.ts:18-25`; tesote `stacks/multi-ai-router/k8s/overlays/production/configmap.yaml` (`SHUTDOWN_READY_GRACE_MS: "20000"`).
- **Defect:** `runtime.closeAdmission()` runs first, so "still serving while the load balancer notices" is false for the data plane.
- **Failure scenario:** rollout 2026-11-10: `readiness withdrawn` 15:11:22.086 → 22 × `503 RequestAdmissionUnavailableError` 15:11:27–15:11:46 → `in-flight requests drained` 15:11:46 → listening 15:12:23. 14 d: 178 such 503s over 18 rollouts, each logged at `error` with a stack. On tesote's public path there is no balancer at all (hostPort → Envoy → 127.0.0.1), so the grace can never help.
- **Fix:** router: move `admission` after `readiness-grace` (close it with the listener). Log the expected shutdown 503 at `info`, no stack. tesote: set `SHUTDOWN_READY_GRACE_MS` to `0` (single replica, `Recreate`) and give those 20 s to `SHUTDOWN_DRAIN_MS` (12.7); keep Envoy `preStop` ≥ grace + drain + 5 and the `__tests__/manifest-invariants.test.ts` shutdown case in step.
- **Test:** integration: SIGTERM with `SHUTDOWN_READY_GRACE_MS=500`, request at +100 ms is served 200, `/readyz` is 503.

### 12.3 high — A Postgres outage produced 52 generic `500`s and lost usage rows
- **Kind:** nn-violation (rule 7 "never a generic 500"; rule 8 Postgres on the request path) — prod confirmation of 01.1 / 01.8 / 07.4
- **Where:** owner 01 `apps/api/src/services/dataplane/auth/` (key lookup), owner 07 usage writer.
- **Defect:** when a key's cache entry expires the lookup query is on the request path and its failure surfaces as an untyped drizzle `Error`.
- **Failure scenario:** 2026-10-31 19:38–20:00Z, pg-production restarting (`getaddrinfo ENOTFOUND pg-production-0…`): 52 × `POST /v1/messages` `500 errorClass=Error` "Failed query: select … from api_keys where prefix = $1 …" (params redacted in the log — good); 101 `database probe failed`; 3 × `usage batch write failed twice — records lost`; 10 × `scheduled task bookkeeping failed`; 22 × `quota window writes failed`. Ten further `500`s in the router's completion log have no `request failed` line (not classified here).
- **Fix:** serve the last verified key on a lookup failure (stale-while-error, bounded by a config TTL), and map a store failure to a typed `503` + `Retry-After`. Usage: per 07.4.
- **Test:** integration: key cache expired + repository throwing → 200 from stale entry; unknown key + repository throwing → 503, never 500.
- **Re-run:** `…query.ts logs '{namespace="multi-ai-router",container="router"} |= "request failed" |= "\"status\":500"' --since 14d --limit 60`.

### 12.4 high — Overhead budget is not met in production on any route
- **Kind:** perf — prod confirmation of 02.1 / 02.2 / 06.2 / 07.1
- **Where:** owner 02 (scanner, framing), 06 (parse), 07 (observer); `router_overhead_seconds` definition in `apps/api/src/observability/metrics.ts`.
- **Defect:** p99 is 4–13× the 5 ms budget and grows linearly with prompt size on both paths, passthrough included.
- **Failure scenario:** 7 d, successes, by input tokens (incl. cache read) `<2k / 2–10k / 10–30k / 30–60k / 60–120k / >120k`: translate p50 `1/1/2/3/5/9` ms, p99 `37/2/4/6/10/19`; passthrough p50 `0/0/1/2/3/5`, p95 `252/1/2/3/5/16`. Share of successes ≥ 5 ms: 14.5 % (zai passthrough) to 49 % (anthropic→openrouter). Passthrough p99 sits on a 250 ms grid (251 / 501 / 2,504 / 5,004) — recovery-coordinator ticks counted as overhead.
- **Fix:** per the owning slices; additionally split the deliberate recovery wait out of `router_overhead_seconds` / `router_overhead_ms` (own label or own histogram) so the budget metric can carry an alert; extend the histogram past 0.1 s.
- **Test:** `bin/bench` with a 300 KB transcript body (02.13).
- **Re-run:** `select egress_mode, width_bucket(tokens_in+coalesce(cache_read_tokens,0), array[2000,10000,30000,60000,120000]) tb, count(*), percentile_disc(0.5) within group (order by router_overhead_ms), percentile_disc(0.99) within group (order by router_overhead_ms) from usage_records where created_at > now()-interval '7 days' and outcome='success' and router_overhead_ms < 1000 group by 1,2`.

### 12.5 medium — Requests wait 2–5 s for a recovery permit and are then refused while the account is serving
- **Kind:** bug (`unverified` mechanism)
- **Where:** owner 03 `apps/api/src/services/dataplane/recovery-wait.ts`, `apps/api/src/services/recovery/coordinator.ts`; `apps/api/src/config/recovery.ts:41` (`RECOVERY_REQUEST_WAIT_MS` 5,000).
- **Defect:** the wait budget is shorter than a recovery probe on a slow provider, so waiters time out behind a probe that then succeeds.
- **Failure scenario:** 2026-11-09 19:59Z, 4 zai `429 zai:throttle-code` → 239 instant router 429s in 2 min → recovery `issued_at 20:02:10.307`, `outcome_at 20:02:31.307` (21 s; zai mean latency is 27.8 s) → in that minute 10 zai successes and 15 requests that waited ≥ 2 s then got `429`. 14 d: 13,325 router 429s after 2–4.9 s and 1,162 after ≥ 5 s (19 % of router-made 429s); 16,999 `waiting for a recovery permit`, 30,570 `candidate dropped … recovery-admission-refused`.
- **Fix:** let waiters ride the probe's outcome (wake on settle, bounded by the probe's own deadline) or admit them once the probe has its first byte; do not enter the wait when the provider-reported reset is beyond the deadline. Update `docs/idea/05-routing-and-failover.md`.
- **Test:** unit, injected clock: probe settles at 8 s, waiter with 5 s budget → served, not 429.

### 12.6 medium — One zai seat: 38 % of all requests are router-made `429`s, and the stack's critical alert fires on it
- **Kind:** capacity + alert design
- **Where:** `tesote/infrastructure` `platform/observability/config/alerts.yml` (`MultiAiRouterErrorRate`, `MultiAiRouterNoActiveAccount`); operator (account pool).
- **Defect:** `glm-*` is served by a single account, so every zai throttle or window exhaustion has no sibling; the error-rate rule counts `quota_exhausted` as an outage.
- **Failure scenario:** 76,212 router 429s vs 1,935 upstream 429s (39 : 1); 2026-10-28 19,697 and 10-29 23,239 in a day with ≤ 87 upstream attempts; key #1 models `glm-5.3` 45,403 / `glm-5.3-flash` 30,586 over 7,443 sessions that ignore `Retry-After`. Now: zai weekly/monthly limit spent, upstream states reset 2026-11-12 13:13Z. `ALERTS{alertname="MultiAiRouterErrorRate",alertstate="firing"}` has 8,853 samples in 14 d.
- **Fix:** tesote: add a second zai seat or map `glm-*` to a second provider; split the alert — page on `no_healthy_account|upstream_*|router_error|credential_decrypt_failed`, warn on `quota_exhausted` share per model; add per-provider `sum by (provider) (router_accounts{status="active"}) == 0`. Router side: none (the 429 is honest).

### 12.7 medium — 18 rollouts in 14 days; 11 of them hit the drain deadline and cut live streams
- **Kind:** ops
- **Where:** `tesote/infrastructure` `stacks/multi-ai-router/k8s/overlays/production/{kustomization.yaml,configmap.yaml}`, `k8s/base/deployment.yaml` (`terminationGracePeriodSeconds: 100`, Envoy `preStop` 45 s).
- **Defect:** every upstream tag is rolled the same day through `Recreate`; `SHUTDOWN_DRAIN_MS` 20 s is shorter than a normal completion (zai mean 27.8 s, openai-oauth 7.1 s).
- **Failure scenario:** 18 `shutting down` lines, 11 `drain deadline expired — closing responses still in flight`, 7 `in-flight requests drained`; 21 `usage_records` rows `router_shutdown` (mean latency 86 s zai / 417 s openai-oauth); Envoy `UF 503` bursts in each gap; `MultiAiRouterEdgeDown` and `MultiAiRouterNotReady` 10 samples each.
- **Fix:** batch bumps (one a day unless a fix is needed); `SHUTDOWN_DRAIN_MS` ≥ 60,000 with `SHUTDOWN_READY_GRACE_MS: "0"` (12.2), Envoy `preStop` ≥ 65, `terminationGracePeriodSeconds` ≥ 125; the invariants test already checks the inequality.

### 12.8 medium — Codex streams that produce nothing hold the client for exactly 15 minutes
- **Kind:** bug (`unverified` — which side owns the 900 s clock)
- **Where:** owner 02 `apps/api/src/services/dataplane/upstream-deadline.ts` (idle 55 s did not fire), owner 04 `apps/api/src/providers/drivers/openai-oauth.ts`.
- **Defect:** an upstream that sends headers and keepalives but no content defeats the idle clock.
- **Failure scenario:** 119 `openai-oauth` `upstream_error` rows at 900,108–901,440 ms, `ttfb_ms` ≈ 1.1 s, `tokens_out 0` — 90 on 2026-11-04, 28 on 11-05, 1 on 11-10 (`gpt-6.1-sol`). No router default is 900 s for a stream (`UPSTREAM_STREAM_TIMEOUT_MS` 1 h).
- **Fix:** make the idle clock count content-bearing events, not bytes, for drivers whose upstream emits keepalives; name the deadline in `error_class`. (The 31 `upstream_timeout` rows at 600,00x ms are 2026-10-29/30, before 2.41.0 — already fixed.)
- **Test:** unit on the deadline with a ticker: keepalive-only stream → `idle` fires.

### 12.9 medium — Hourly history backfill reads the whole table (prod numbers for 08.2)
- **Kind:** db
- **Where:** owner 08 `packages/db/src/repositories/usage-history-maintenance.ts:42`.
- **Defect:** the anti-join restarts from the beginning every sweep.
- **Failure scenario:** `pg_stat_statements`: 655 calls, 0 rows, mean 360 ms, max 901 ms, 568,709 shared buffers per call (≈ 4.4 GB) at 297k rows; it accounts for the 84,497,363 scans of `usage_contributions_kind_id_pk`. Linear in table size — ≈ 4× at the 90-day retention.
- **Fix / Test:** per 08.2.

### 12.10 medium — `plan_quota_read` has been `partial` on every run since 2026-11-07; zai has no stored quota window
- **Kind:** bug
- **Where:** owner 04 `apps/api/src/providers/drivers/zai.ts` (plan quota read), owner 07 scheduler outcome.
- **Defect:** the zai plan read returns `quota:unreadable` every 15 min, so the task can never report a new failure and zai's cooldown/reset lives only in memory.
- **Failure scenario:** `scheduled_task_runs`: 384 `partial`, last `success` 2026-11-07 00:05Z; 383 `plan quota read failed for an account` warns; `quota_windows` holds one row (openai-oauth `seven_day`); `accounts.status` for zai is `active` while `router_accounts{provider="zai",status="cooling_down"} 1` and the upstream states a reset two days out — a restart forgets it.
- **Fix:** read zai's current plan-quota shape (capture one redacted response); an account whose plan read is unsupported is `skipped`, not `partial`; persist a provider-reported reset.
- **Test:** unit with the captured fixture.

### 12.11 medium — Alert rules cover up/down only; nothing watches the router's own failure signals
- **Kind:** ops
- **Where:** `tesote/infrastructure` `platform/observability/config/alerts.yml` group `multi-ai-router`, `docs/runbooks/alerts.md#multi-ai-router`.
- **Defect:** six rules (edge, not-ready, restarting, metrics-down, no-active-account, error-rate). Every metric they name exists in 2.55.0 (`router_accounts`, `router_requests_total`, outcome values match `UsageOutcome`). Missing: `router_task_consecutive_failures > 0` / stale `router_task_last_success_timestamp_seconds`; `router_accounts{status=~"needs_reauth|exhausted"} > 0` (the only ChatGPT account sat `needs_reauth` 2026-11-06 13:28–15:22Z unalerted); `router_credential_rejected`; `router_usage_records_dropped_total` / `router_usage_write_failures_total`; `router_db_pool_connections{state="waiting"}`; `router_overhead_seconds` p99; 5xx share from Envoy.
- **Fix:** add those rules with promtool cases in `platform/observability/__tests__/alerts.promtool.yml`.

### 12.12 low — Dead indexes and non-HOT updates (prod numbers for 08.6)
- **Kind:** db
- **Where:** owner 08 `packages/db/src/schema/{accounts,usage-records,usage-contributions}.ts`.
- **Failure scenario:** `accounts`: 179,229 updates, 6 HOT (`update accounts set last_used_at` 176,622 calls) with `accounts_last_used_at_idx` at 0 scans; `usage_records_client_request_idx` 20 MB / 0 scans; `usage_records_correlation_idx` 11 MB / 4 scans; `usage_contributions_source_idx` 31 MB / 251 scans; `accounts_status_idx`, `accounts_config_dir_key`, `quota_windows_resets_at_idx`, `quota_windows_pkey` 0 scans. `model_catalog`: 13,244 inserts / 13,222 deletes for 22 live rows.
- **Fix:** per 08.6; upsert `model_catalog` instead of delete + insert.

### 12.13 low — Recovery coordinator polls Postgres 4.2×/s with nothing pending (prod numbers for 03.11)
- **Kind:** db / perf
- **Where:** owner 03 `apps/api/src/services/recovery/coordinator.ts:145` (`listExpiredIssued` every tick), `apps/api/src/config/recovery.ts:31` (250 ms).
- **Failure scenario:** 195 calls in 46 s at idle; 9,210,890 calls returning 81 rows; 10,193,381 seq scans on a 3-row table; ~1.1 M statements/day across the four `account_recoveries` shapes.
- **Fix:** skip the expiry read when this boot holds no `issued` permit and none was seen at the last slow sweep; back off to a slow cadence when idle.

### 12.14 low — Every OpenRouter success is `cost_basis = unknown`
- **Kind:** bug
- **Where:** owner 07 `apps/api/src/services/cost/` (price lookup keyed on the client model id).
- **Failure scenario:** `openrouter` × `gpt-6-luna` 3,102 + `openai/gpt-6-luna` 1 → `unknown` (100 %); `router_cost_basis_total{basis="unknown"}` 3,091 in 14 d. The same model on `openai-oauth` is `notional`.
- **Fix:** resolve price by `upstream_model` after the alias map, with the provider-prefixed id as a fallback.

### 12.15 low — Log hygiene
- **Kind:** structure
- **Where:** owner 06 (translate warn), 01 (transport), 03 (pool message).
- **Defect / scenario:** `translation dropped fields` at `warn` 15,379 times, the same tool-schema pattern on every request of one client (9 % of all warn lines after the 429s) — once per (key, field) is enough. `QuotaExhaustedError` text carries account labels verbatim, and one label here contains an operator email; it is in the log and, unless rendered differently, in the client's 429 body — name accounts by provider + ordinal toward clients. `recovery coordination failed; retrying off path` (275, all 2026-11-06) logs no reason. The completion line's `durationMs` is time-to-headers for a stream (router 942 ms vs Envoy 7,684 ms for one request id). `GET /.git/config` answers 200 (SPA fallback) — dot-paths should 404.

### 12.16 low — Stack docs trail the pin; the working copy trails `main`
- **Kind:** docs
- **Where:** `tesote/infrastructure` `stacks/multi-ai-router/README.md` (origin/main lines 98-114, 205-212).
- **Defect:** the Image row says v2.55.0 but "Release 2.45.6", the bootstrap mirror commands and "deployed: `2.45.6`", "CLI 2.1.301/Bun 1.4.2" are six releases old; `__tests__/secrets-contract.test.ts` pins only the `stack.yml` alias against the overlay. The developerz-ai manifest in the local checkout pins `2.52.1` (checkout may be stale — auditor 10 has the live value).
- **Fix:** drop the per-release section (the overlay comment block is the changelog) or extend the alias test to every version string in the README.

### 12.17 low — Volume and sizing notes
- **Kind:** ops
- **Where:** `tesote/infrastructure` `stacks/multi-ai-router/k8s/base/{pvc.yaml,deployment.yaml}`.
- **Defect:** `local-path` does not enforce the 4 Gi request (`df` shows the node's 410 G filesystem) and exports no `kubelet_volume_stats_*`, so a transcript leak fills worker-4 unseen; today the volume is empty (0 entries). The 12 Gi limit / `CLAUDE_SDK_MAX_CONCURRENCY=24` are sized for subprocesses that have never run here (max RSS 177 Mi) — harmless, the request is 1 Gi.
- **Fix:** if a Claude subscription is ever added, alert on `du` of the PV path via node-exporter textfile, or move to a quota-enforcing class.

### 12.18 low — Metrics that disagree with the system
- **Kind:** bug
- **Where:** owner 01/07 `apps/api/src/observability/`.
- **Defect:** `router_db_pool_connections{state="idle"} 12` while `pg_stat_activity` shows 4 backends for the role (the gauge reports capacity, not sockets). No process RSS / heap / event-loop-lag series is exported, so a leak is visible only through cAdvisor.
- **Fix:** report opened connections; add `process_resident_memory_bytes` and an event-loop delay histogram.

### 12.19 low — Restore confidence and key rotation for the router's database
- **Kind:** ops
- **Where:** `tesote/infrastructure` `platform/db/postgres-pitr.yaml`, `docs/runbooks/rotate-secrets.md`, `docs/platform/backups.md`.
- **Defect:** `CronJobLastRunFailed platform/pg-production-pitr-drill` has been firing since 2026-11-08 (RPO stays the 4 h dump); `rotate-secrets.md` has no `multi-ai-router-secrets` row — `ENCRYPTION_KEY` has a "cannot be regenerated" note and no rotation or loss procedure, `METRICS_TOKEN` rotation lives only in the stack README.
- **Fix:** fix the drill; add the row (and state plainly whether the router supports re-encryption — owner 01 to answer).

## Checked, not a bug
- Direct `:5432`, never pgcat: `DATABASE_URL` contract, egress policy and `platform/db/platform-networkpolicy.yaml:124-133` agree; role `CONNECTION LIMIT 40` vs 4 live backends; no advisory lock stuck (0 held at sample time, 0 unfinished `scheduled_task_runs`).
- Envoy: no buffer filter, route `timeout: 0s`, `request_timeout: 0s`, `stream_idle_timeout: 600s`, no retry policy (nothing is replayed), XFF overwritten, access log has no path / query / headers / body, no admin listener, vhost bound to the real hostname (625 wrong-Host `NR 404` per day never reach the app). Envoy `preStop` held 45 s as designed (SIGTERM logged 15:12:07 after 15:11:22).
- No Cloudflare in the path (DNS-only A record) — no 100 s edge timeout, no proxy buffering.
- Replicas 1 + `Recreate` is forced by the RWO local-path volume and hostPort and matches the router's in-memory health/cooldown/binding state; PDB `minAvailable: 0` is deliberate.
- Security context: non-root, read-only root, all caps dropped, seccomp RuntimeDefault on both containers; `automountServiceAccountToken: false`; secrets referenced per key; `ADMIN_API_TOKEN` and `SENTRY_DSN` unset by design.
- Every env name in the ConfigMap / Deployment exists in the router's schema except `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, which is deliberately a pass-through to the CLI subprocess (and inert here: no Claude account).
- Probes: startup `/healthz` 2 min, liveness `/healthz`, readiness `/readyz`; boot incl. migrations is ≈ 1.5 s (`migrations applied` 15:12:23.173 → `router listening` 15:12:23.973).
- `nofile` 1,048,576; cert valid 62.8 days, renewed live by SDS.
- 0 container restarts, 0 OOM in 14 d; no credential-shaped material seen in any sampled log line (query params are `[REDACTED]`).
- Every `usage_records.correlation_id` has a `usage_request_terminals` row (297,594 = 297,594, 0 orphans). `http_status NULL` (76,563) is exactly the rows with no upstream attempt.
- `MultiAiRouterRestarting`, `…MetricsDown`, `…NoActiveAccount` never fired; scrape is up; all alert expressions reference live series.
- Retention: oldest usage row is 27 days old against the 90-day default — nothing to judge yet; `janitor_sweep` 341 runs, 0 items.

## Doc claims falsified
- `docs/idea/09-deployment.md:505-506` says traffic is still served during `SHUTDOWN_READY_GRACE_MS`; `apps/api/src/main.ts:126` closes admission first and prod answers `503` for the whole grace (12.2).
- `docs/idea/09-deployment.md:135` says a non-streamed inference request is off the listener idle clock until its last byte; zai passthrough answers are cut at ~60 s (12.1).
- tesote `stacks/multi-ai-router/README.md:98,205` (origin/main) says release / deployed `2.45.6`; the overlay pins and the pod runs `2.55.0`.

## Steps
1. Router, owner 01: reproduce and fix 12.1; reorder shutdown phases and demote the log (12.2); typed 503 + stale key on store failure (12.3). One commit each, docs/idea/09 in the same commits.
2. Router, owner 03: recovery waiter rides the probe outcome (12.5); idle the coordinator's expiry read (12.13).
3. Router, owners 02/04: content-aware idle clock for Codex (12.8); zai plan quota read + `skipped` outcome (12.10).
4. Router, owners 07/08: backfill watermark (12.9 = 08.2), index drops (12.12 = 08.6), price lookup by upstream model (12.14), pool gauge + process metrics (12.18), split recovery wait out of the overhead metric (12.4).
5. Router, owners 06/01/03: log hygiene (12.15).
6. `tesote/infrastructure` (own repo, own PR): shutdown values (12.2, 12.7), alert split and new rules with promtool cases (12.6, 12.11), README (12.16), rotate-secrets row and PITR drill (12.19), second zai seat (operator).

## Tests
- Named per finding; router ones are `bun test <file>` on the new integration/unit files, then `bunx biome check <changed files>` and `bun run typecheck` once.
- tesote: `bun test stacks/multi-ai-router/__tests__ platform/observability/__tests__` in that repo.

## Done when
- A non-stream passthrough answer taking 70 s returns 200 through Envoy; no `UPE` lines for a week.
- A rollout produces 0 `RequestAdmissionUnavailableError` lines and 0 `drain deadline expired` lines.
- No `status:500` in a week of router logs, including across a pg-production restart.
- `router_overhead_seconds` p99 (recovery wait excluded) < 5 ms for bodies ≤ 150 KB on both paths.
- `plan_quota_read` reports `success` or `skipped`; `MultiAiRouterErrorRate` is silent while only `quota_exhausted` is elevated.

## Not covered
- `kubectl logs --previous` (0 restarts — nothing to read); Envoy flag totals beyond 1 day (the 7 d and 14 d LogQL aggregates returned nothing — likely a series/time limit; the `UPE`/`UF` line listing covers 3 d).
- The ten `500`s with no `request failed` line; whether the 429 body (not just the log) carries account labels; whether all 178 admission 503s fall inside rollout windows (the 22 sampled do).
- Why `holdIdleClock` fails on passthrough (12.1) and who owns the 900 s clock (12.8) — fingerprints only.
- `EXPLAIN` of the main query shapes (tables are 3–30 rows except usage; `pg_stat_statements` used instead); rollup watermark lag beyond `usage_rollup` succeeding hourly.
- Secret values, sealed-secret contents, `auth_material` and key columns — not read by design. ArgoCD UI / Grafana dashboards not opened.
- Live developerz-ai pin (auditor 10); router support for `ENCRYPTION_KEY` rotation.
- In-cluster callers bypass Envoy, so their share of 12.1 is visible only in `usage_records`.
