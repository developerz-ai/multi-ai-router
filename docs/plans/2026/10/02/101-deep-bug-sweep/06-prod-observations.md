# 06 — Production observations

> Part of [`overview.md`](overview.md). Depends on: none. Owns: nothing in this repo directly — each finding names the slice that owns its fix, plus `../infrastructure/stacks/apps/multi-ai-router/` (edited from its own repo).

Evidence pulled 2026-10-02 ~23:50 UTC from pod `multi-ai-router-8674b5f6df-zz5rj` (worker-2, up ~7–8 h, release `2.15.0` per boot log) + `multi_ai_router` DB. Access recipe: `../infrastructure` ssh-wrapped kubectl (`scripts/k8s/logs.ts`, `kubectl exec postgres-1 … psql`). Window: pod log since 15:58 UTC; `usage_records` last 8 h.

Traffic in window: 1 504 info / 116 warn / 0 error lines. `/v1/messages`: 63 × 200, 57 × 400, 50 × 429. 949 × `GET /`. All successes on `kimi`; Claude subs idle in window.

## Findings

### 06.1 high — Router overhead ~80 ms avg, p99 ~250 ms — 50× the 5 ms budget
- **Resolved by dive (→ 01.1):** measurement bug, not CPU. The overhead clock starts before `readRequestBody` awaits the client's upload; the numbers fit a steady ~1.3 MB/s upload. In-process body read + scan of 292 KB = 0.6–2 ms. Fix lives in 01.1.
- **Where:** `usage_records.router_overhead_ms` (computed in `apps/api/src/services/dataplane/records.ts:20-45`); request path in `apps/api/src/services/dataplane/`.
- **Defect:** recorded overhead avg 82 ms / p99 252 ms on successes; **88 ms avg on pre-routing rejections that never touched an upstream** (`account_id IS NULL`, 43 rows). Rejected-429 durations cluster 63–81 ms and 188–223 ms, outliers 1–2 s; tiny-body 400s finish in 2–29 ms → cost scales with body size (75–280 KB bodies).
- **Failure scenario:** `team` key, 75 KB `/v1/messages` body, pool with all candidates cooling → 429 after ~65 ms; 280 KB body → ~200 ms. Non-negotiable 8 violated, or the metric is wrong — either is a bug.
- **Fix:** profile the pre-dispatch path with a 280 KB body under `bin/bench` (add a large-body scenario). Suspects, unverified: full JSON parse + re-serialize for model sniffing on a same-dialect body (NN 10), token estimation over the whole prompt, per-candidate translation done eagerly before eligibility, sync crypto on key verify. Owner: slice whose file the profile lands in (likely 01 dataplane or 04 translate).
- **Test:** `bin/bench` large-body case asserting p99 overhead < 5 ms; regression baseline in `bench/baseline.json`.

### 06.2 medium — Every Kimi success has `cost_basis = unknown` (→ 02.7)
- **Where:** `usage_records` (63/63 kimi success rows `unknown`); price tables in `apps/api/src/services/cost/`.
- **Defect:** no price entry (or alias miss) for the models served by `kimi` → cost dashboards undercount the only traffic in the window.
- **7-day prod tally (successes):** `kimi`/`k3` 128 × `unknown`; `openai-compatible`/`qwen3.8-max` 502 × `unknown`; `minimax`/`MiniMax-M3` 2 045 × `metered` (fine). So ~24 % of successful traffic has no cost.
- **Fix:** diagnosis in 02.7 — the Kimi table only carries platform `kimi-*` names, not coding-plan names (`k3`, `k3-256k`, `kimi-for-coding*`); `openai-compatible` has no table at all. Add coding names with a provenance comment; for compatible accounts, operator `price_overrides` (or the cross-table fallback 02.7 proposes). Overlaps #138 "price-table follow-ups". Owner: slice 02.
- **Test:** unit — cost estimate for each Kimi catalog model ≠ `unknown`.
- **Checked, not a bug:** `zai` rows with `model=MiniMax-M3 → upstream_model=glm-5.2` come from the account's explicit `model_aliases` (operator-configured) — allowed by NN 4.

### 06.3 medium — Router-generated 429s write `http_status = NULL` (→ 01.6; by spec today, needs a `response_status` column)
- **Where:** 43 `usage_records` rows `outcome=quota_exhausted, error_class=QuotaExhaustedError, http_status NULL, account_id NULL` — client received 429.
- **Defect:** the record for a pre-dispatch rejection drops the status the client actually got; usage-by-status queries and the console misreport. Owner: slice 01 (`services/dataplane/records.ts` caller).
- **Test:** integration — all-candidates-cooling request → row with `http_status = 429`.

### 06.4 medium — 400 `invalid_request` rejections write no `UsageRecord` (→ 01.7; deliberate skip, contradicts CLAUDE.md — decide)
- **Where:** 57 × 400 in log (body `{}`, `content-length: 2`, UA `Bun/1.3.14`), zero matching rows.
- **Defect:** CLAUDE.md Testing: "Assert a `UsageRecord` row per request, including failures." Authenticated malformed requests are invisible in usage. Decide: record (model `""`/`unknown`) or document the exclusion in `docs/idea/08-observability.md`. Owner: slice 01.
- **Side note:** the client behind one fleet key posts `{}` ~every 8 min — client-side bug (likely a liveness ping); worth telling its owner.

### 06.5 low — Alibaba token-plan reset time in body not parsed (→ 03.4, reproduced against the real body)
- **Where:** `upstream attempt failed` 429, `signal http-status:429`, body `"…1-month quota has been exhausted. The quota will reset at 10-13 16:00:00 UTC."`; aggregate error then reports only an *estimated* earliest reset.
- **Defect:** a provider-stated reset 11 days out is ignored; the account gets a generic estimated cooldown → re-probed / retried long before Oct 13, and the console shows a wrong countdown. Owner: slice 03 (`providers/rate-limit/parse.ts` or the `openai-compatible` rules file — one file).
- **Test:** unit — that body → `resetsAt = 2026-10-13T16:00Z`, `reset_source = provider-reported`.

### 06.6 low — Spent Claude weekly windows live only in memory (→ 02.8 / 02.9: metered cooldowns memory-only by design; Claude rows fine)
- **Where:** two Claude-sub accounts: `quota_windows.seven_day utilization = 1`, `accounts.status = active`; `kimi`/`alibaba` cooling with no `quota_windows` row.
- **Defect:** unverified — cooling state for metered accounts appears to be in-memory only; a pod restart forgets it and the first requests re-hit spent upstreams. Confirm against `services/health/` persistence. Owner: slice 02.

### 06.7 low — infra: manifest pins `2.14.0`, pod reports `2.15.0`
- **Where:** `../infrastructure/stacks/apps/multi-ai-router/manifests/deployment.yml:349` vs boot log `release: 2.15.0`.
- **Defect:** pin drift (manual rollout or unmerged infra PR). GitOps re-sync would downgrade. Fix in `../infrastructure`: bump image tag + README version cell + `application.yml` comment.

### 06.8 low — infra: 949 × `GET /` in 8 h (~every 30 s)
- **Where:** request log; k8s probes correctly use `/healthz`/`/readyz` (`deployment.yml:448-475`), so this is an external uptime monitor.
- **Defect:** monitor fetches the SPA shell (logged, no health signal). Point it at `/readyz`.

## Healthy
- Scheduler: every task `success` in last 24 h (one `model_catalog_refresh` `partial`), advisory locking fine on 1 replica.
- `cooling_down` vs `exhausted`: `openrouter-glm53-fallback` `exhausted` → reported "needs a top-up", Kimi weekly/5-h limits → 429 + reset. Correct per NN 7.
- No `error`-level lines; no credential material seen in sampled warn lines.

## Done when
- 06.1 reproduced in `bin/bench` and fixed or the metric corrected; 06.2–06.6 fixed in their owner slices; 06.7–06.8 fixed in `../infrastructure`.

## Not covered
- Only the current container log (~8 h); no Claude-sub traffic in window; GlitchTip events not pulled.
