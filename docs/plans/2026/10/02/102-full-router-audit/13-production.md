# 13 — Infrastructure and production evidence

> Part of [overview.md](overview.md). Depends on: all code slices. Owns: `../infrastructure/stacks/apps/multi-ai-router/`, router-specific monitor configuration in `../infrastructure/stacks/platform/observability/blackbox-exporter/manifests/probe.yml`, and this evidence directory. Application fixes are owned/countable only in their code slice.

## Evidence scope

Read-only SSH-wrapped kubectl through `../infrastructure/scripts/lib/k8s/kubectl.ts`. SQL ran inside the primary Postgres pod with `default_transaction_read_only=on`, a 15-second statement timeout, explicit `BEGIN READ ONLY` and `ROLLBACK`. No table contents containing credentials, user prompts or personal account identifiers were exported.

Initial production snapshot: 2026-10-02 23:58 UTC. Logs: current pod from 15:58:44 UTC to capture (~8h), not 24h despite requesting --since=24h. SQL: rolling 24h plus complete recent UTC dates for rollup comparisons. Subsequent captures in [evidence/](evidence/) include timestamps. The first and last partial calendar days of a rolling query are not comparable to whole-day rollups.

| Surface | Observed |
|---|---|
| Runtime | `multi-ai-router-8674b5f6df-zz5rj`, worker-2; image 2.15.0, Ready, 0 restarts |
| Deployment | Argo Synced + Healthy, revision `fd2528e1cf7e0931c8754296dd8d09f708029de5`; remote main manifest also 2.15.0 |
| Resources | 8 millicores, 83 MiB at sample; no namespace Warning events |
| Postgres | 126 MB; 25 migrations; ~308,109 estimated live usage rows |
| Connections | two idle sessions plus audit query; no observed waiting database lock |
| Backups | latest completed 2026-10-02 01:17:51 UTC; daily backups September 21–October 2 completed; Ready and ContinuousArchiving conditions true |
| Scheduled tasks | 24h: all successful except one partial model-catalog refresh; zero unfinished runs older than one hour |
| Accounts | 11: 6 Claude subscriptions active; one OpenRouter exhausted; Kimi, z.ai, MiniMax active; one compatible subscription active |

### Request / usage evidence

| Measure | Initial observation | Interpretation / owner |
|---|---:|---|
| Current-pod `/v1/messages` completions | 63 × 200; 57 × 400; 50 × 429 | Count `request completed` only: `request failed` is another log for the same failed request |
| Current-pod levels | 1,517 info; 116 warn; 0 error (1,633 lines at 23:57:51) | Zero error-level lines does not mean successful requests |
| 24h no-account quota rejections | 161 | account_id/provider/http_status NULL; 01 owns response/usage status semantics |
| 24h Kimi success | 109, all upstream model `k3`, cost unknown | 08.1 |
| 24h Kimi other attempts | 32 client errors; 6 quota 403; 3 timeout; 1 auth 403 | Window spans releases; do not re-file fixed 403 classification from old rows |
| Other 24h attempts | z.ai 1 success; compatible provider 1 quota 429 | Actual provider mix; no user Claude-sub completion in these records |
| No-account overhead | avg 75.84 ms, p99 245.6 ms | Measured symptom; body-upload time/metric boundaries must be separated from actual added processing |
| Kimi-success overhead | avg 95.47 ms, p99 256 ms | 01 investigates; not proof that passthrough JSON is reserialized |
| Oct 1 UTC counts | raw 31; no-account 8; rolled 23 | Exactly 8 omitted by rollup filter: 10.1 |
| Sep 30 UTC counts | raw 10; no-account 8; rolled 2 | Independent confirmation: 10.1 |
| Sep 29 UTC counts | raw 17; no-account 12; rolled 5 | Same causal chain |

## Saved data

- [Production SQL results](evidence/production-db.txt) — aggregate counts, model cost coverage, scheduled-task outcomes, table estimates and connection states.
- [Reproducible read-only queries](evidence/production.sql) — explicit transaction and bounded query deadline in [reader](evidence/cluster-read.ts).
- [Current-pod log counts](evidence/production-logs.json) — timestamps, levels, messages and deduplicated completed-request statuses; no request bodies.
- [Cluster and backup status](evidence/cluster-status.txt) — pod/image/resources, warning events, CNPG health and completed backup timestamps.
- [Local reproductions](evidence/local-reproductions.txt) — actual observer, identity, axis, cache and stale-sweep results, with [source](evidence/local-reproductions.mjs).

## Local performance cross-check

`bin/bench --requests 1000 --warmup 100 --json` passed with default 1,024-byte prompts. Repeating with `--prompt-bytes 280000` failed: translated p99 **11.11 ms**, translated-stream p99 **10.00 ms**, versus 5 ms budget; passthrough p99 5.00/4.96 ms. Both runs: zero failed requests, zero buffered streams. Streaming added TTFT p95 below 0.15 ms at 1 KB, below 0.1 ms at 280 KB. See [small](evidence/bench-1k.json) / [large](evidence/bench-280k.json).

A separate [delayed-body reproduction](evidence/upload-timing.txt) shows a 100 ms client-body delay recorded as 101 ms overhead. Thus production's ~250 ms p99 is **not proof of ~250 ms router computation**. Local benchmark establishes a smaller, reproducible large-translation breach; production profiling remains necessary. No real upstream or database used by these benchmarks.

## Findings

### 13.1 low — Infrastructure runbook describes removed session limitation
- **Where:** `../infrastructure/stacks/apps/multi-ai-router/README.md:29`; `manifests/deployment.yml:44` and `:73` in local checkout.
- **Defect:** documentation says admin sessions are memory-only and restarting/scaling loses them; current app stores hashed sessions in Postgres (`packages/db/src/schema/admin-sessions.ts:15`, `services/admin-auth/postgresSessionStore.ts`).
- **Failure scenario:** operator diagnosing logout or evaluating recovery follows an obsolete root cause and misses current cookie/expiry behavior.
- **Fix:** update factual session persistence descriptions while retaining the separate in-process rate-limit, health and CLI-concurrency scaling constraints. Refresh the infrastructure checkout before editing; current remote code may have shifted line numbers.
- **Test:** reviewed runbook references current session store and does not recommend additional replicas until other constraints are addressed.

## Rejected / unverified earlier claims

- **Image pin drift rejected:** local infra HEAD `ba9b254` is stale. Remote main, Argo and live pod agree on 2.15.0. No live downgrade drift proven.
- **Spent Claude windows lost on restart rejected:** quota_windows persists those windows and catalog reload hydrates them. `accounts.status=active` alone does not mean routable; it differs from effective health/window state.
- **NULL http_status is not automatically a defect:** schema currently defines it as upstream response status, so no upstream legitimately gives NULL. 01 must assess whether a separate client status is needed; do not silently repurpose the column.
- **GET / monitor is not automatically broken:** blackbox probe explicitly measures public page reachability. A separate readiness signal may be useful, but replacing it changes monitoring intent; Kubernetes already checks /readyz. Do not count ~30-second root requests as a router malfunction.
- **Unparsed Alibaba reset:** prior report cites a body reset date, but provider-specific parsing requires a repeatable fixture and unambiguous year/timezone; not independently re-confirmed here.
- **No error-level log does not prove secret safety:** no secret-bearing fields were requested; no exhaustive historical leak scan claimed.

## Steps
1. Fix application findings in their owning slices; preserve this snapshot as the before evidence.
2. Update infrastructure runbook facts in its own repo after syncing the checkout.
3. After approved deployment, compare equal UTC windows for costs, raw-vs-rolled counts, response outcomes and overhead.

## Tests / done when
Infrastructure docs match running behavior; application fixes are verified by their failure-first tests and bounded read-only post-release evidence. Coordinator runs `bin/check` with disposable Postgres, and `bin/bench` when request path changes.

## Not covered
GlitchTip event history, rotated logs/previous containers, restore drill, PVC credential-directory backup restoration, exhaustive query plans, external-provider billed reconciliation, multi-replica production tests. Backup status demonstrates successful jobs/archiving, not a proven restore.
