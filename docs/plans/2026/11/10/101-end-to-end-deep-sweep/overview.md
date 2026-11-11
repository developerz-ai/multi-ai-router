# End-to-end deep sweep — code, prod evidence, consumers, CI, maintenance

## Goal
One ledger of every defect and improvement found across the router's eleven code areas, both production deployments (developerz-ai, tesote), the apps that call the router, and the repo's tooling and upkeep. 197 findings, nothing fixed while planning. The executor fixes them slice by slice; fixes outside this repo are listed per repo and filed there.

## Context
- Sweep at `v2.55.0` (`a5c7198`), 2026-11-10/11. Bun + TS strict, Hono, Zod, Drizzle over postgres.js, Agent SDK + fast transport for Claude subs, SolidJS + TanStack Solid Query.
- `CLAUDE.md` binds every fix: non-negotiables (NN 1–13), Layers table, NEVER list. Claude fast mode is a supported transport — defects inside it are findings, its existence is not.
- **Evidence beats reading.** Slices 10 and 12 are 14 days of prod logs, Prometheus and Postgres statistics; where they confirm a code finding the worklist says so. Code findings with no prod fingerprint carry the confidence their slice states (many are micro-benchmarks or read-only).
- The two October ledgers (`docs/plans/2026/10/02/101-*`, `102-*`) still say `in_progress` at v2.16.0 (14.10). Do not cite them without re-checking code.
- Every prod query/command an executor needs to re-measure is in the **Re-run** line of the finding. Production access is read-only: `../infrastructure/scripts/k8s/*` (developerz-ai), `tesote/infrastructure` `bin/k8s/kubectl.sh` + `scripts/observability/query.ts` + `scripts/db/sql.ts` (tesote).
- Reference patterns: settled recovery generation `packages/db/src/repositories/account-recovery-generation.ts:61-90` (model for 03.1); banked watermark in `usage-history-maintenance.ts` `coverage` (model for 08.2); `isolatedOptions` for every `query()` site (05.9).

## Plan files (execute in order)
Code slices own exclusive paths. Evidence slices (10, 12, 13) own no code: each of their findings is routed to an owner in **Routed findings** below.

1. [`08-db.md`](08-db.md) — timeouts, backfill watermark, sargable lookups, dead indexes, the one migration `0044`. Owns: `packages/db/**`.
2. [`01-transport-auth-config.md`](01-transport-auth-config.md) — key cache, admin sessions, shutdown order, idle clock, env schema. Owns: `apps/api/src/{routes,middleware,composition,config,errors,logging,observability}/`, `app.ts`, `main.ts`, `services/{admin-auth,admin,keys,crypto,pools,settings,shutdown,dataplane/auth}/`, `packages/core/`.
3. [`04-providers-models.md`](04-providers-models.md) — failure classification, reset parsing, catalog. Owns: `apps/api/src/providers/` except `claude-sdk/` and `claude-fast/`; `services/{models,catalog}/`.
4. [`03-routing-health-accounts.md`](03-routing-health-accounts.md) — re-check gate, recovery coordinator, rotation, selection cost. Owns: `services/{routing,health,recovery,snapshots,accounts}/`.
5. [`02-dataplane.md`](02-dataplane.md) — lease leak, body scanner, relay, chain. Owns: `services/dataplane/` except `auth/`; `apps/api/bench/`.
6. [`07-usage-cost-scheduler.md`](07-usage-cost-scheduler.md) — response observer, usage writer, summary, scheduler. Owns: `services/{usage,usage-read,usage-report,cost}/`, `apps/api/src/scheduler/`.
7. [`06-translation.md`](06-translation.md) — SSE parser, request parse cost, tool-choice edges. Owns: `services/translate/`.
8. [`05-claude-sdk-fast.md`](05-claude-sdk-fast.md) — refresh self-wait, credential read cost, env denylist, structured-output regression. Owns: `providers/claude-sdk/`, `providers/claude-fast/`.
9. [`09-web.md`](09-web.md) — reconcile on refetch, error boundary, carry-overs. Owns: `apps/web/`.
10. [`11-devex-ci-release.md`](11-devex-ci-release.md) — typecheck coverage, release gate, CI time, test isolation. Owns: `bin/`, `.github/workflows/`, `Dockerfile`, compose files, `.env.example`, root `package.json`/`tsconfig*`/`biome.json`, test harness under `apps/api/test/support`.
11. [`14-maintenance-backlog.md`](14-maintenance-backlog.md) — dz maintainer policy, closing references, triage ledger. Owns: `.dz/**`, `.github/pull_request_template.md`, `.github/SETTINGS.md`, labels/issue templates, `docs/plans/**/status.yml`.
12. [`10-production-evidence.md`](10-production-evidence.md) — developerz-ai cluster: logs, metrics, DB. Owns nothing here; baseline numbers to diff against after the fixes.
13. [`12-tesote-deployment.md`](12-tesote-deployment.md) — tesote cluster: manifests + live evidence. Owns nothing here.
14. [`13-consumers.md`](13-consumers.md) — developerz.ai, dz-runner, tesote.ai and manifest-only callers. Owns: `docs/clients.md`.

### Handoffs between slices (who edits the contested file)
| Need | Raised by | Edited by |
|---|---|---|
| New env keys: DB timeouts (08.1), reset ceiling (04.2), SDK pacing/login timeouts (05.4), scheduler run deadline (07.5), catalog first-tick (07.3), `/readyz` probe timeout (03.10), key stale-while-error TTL (12.3) | 03, 04, 05, 07, 08, 12 | **01** (`config/env-schema.ts`, `.env.example` via 11.11) — land the keys first, consumers read them |
| Repository methods: session `deleteByUsername`/`deleteAll` (01.2), combined prefix+scope query (01.8), `settled` on `account-recovery-begin.ts` (03.1), `latestPerTask()` (01.11/08.7), ciphertext-free account projection (07.11/08.9), persisted exhausted-retest ladder (07.6), batched quota-window upsert (02.11) | 01, 02, 03, 07 | **08** — and every schema change rides the single migration `0044` |
| `services/usage/response-framing.ts` + `response-observer.ts` (02.2 ≡ 07.1) | 02 | **07**; 02 only caches the snapshot and hands the peek's parse to the observer |
| `services/dataplane/{orchestrator,rotation,snapshot,recovery-access,recovery-wait}.ts` (03.2, 03.3, 12.5) | 03 | **02** |
| `composition/request-services.ts` (05.2, 05.12), `composition/warm-state.ts` (04.5) | 04, 05 | **01** |
| `services/catalog/store.ts` `byId` index (02.8) | 02 | **04** |
| Provider special cases outside `providers/` (NN 12): `services/models/refresh.ts:74,131` (04.3), `services/cost/prices.ts:87,94,122`, `services/routing/failover.ts:387`, `scheduler/tasks/idle-account-probe.ts:16` | 04 | 04 defines the driver-side field; **07** and **03** delete their own special case |
| `docs/idea/*` | all | the slice whose behaviour changes; `CHANGELOG.md` + version once, by the coordinator |

## Ranked worklist
Counts: **197** — critical 0 · high 30 · medium 79 · low 88. Below: every high, plus the mediums that prod evidence promotes. The rest are ranked inside their slice. "Prod" = fingerprint seen in slice 10 (developerz-ai) or 12 (tesote).

### A. Non-negotiable violations, confirmed in production
| # | Sev | Fix in | `file:line` | Defect | Evidence |
|---|---|---|---|---|---|
| 10.1 | high | 04 | `apps/api/src/providers/drivers/kimi.ts:30,155` | Kimi weekly-window 429 classified `credits-exhausted` → account parked `exhausted`, client gets 402 (NN 7) | 5 parks, 28 × 402 in 37.5 h; window resets 11-12 |
| 12.3 | high | 01 + 07 | `services/dataplane/auth/` key lookup; `services/usage/recorder.ts:137-158` | Postgres restart → generic `500`s on the request path and lost usage batches (NN 7, NN 8) | 52 × 500, 3 lost batches, 2026-10-31. Confirms 01.1, 01.8, 07.4 |
| 10.2 / 12.4 | high | 02 + 07 + 06 | `services/dataplane/body/scanner.ts:167`; `services/usage/response-framing.ts:137-169`; `services/translate/shared/anthropic.ts:153-163` | Overhead budget missed on every route, linear in prompt size (NN 8) | p99 38–82 ms (dz), 23–65 ms (tesote) vs 5 ms. Confirms 02.1, 02.2 ≡ 07.1, 06.2 |
| 12.5 + 03.1 | high | 03 + 02 | `services/accounts/recheck.ts:107-128`; `services/dataplane/recovery-wait.ts` | Router-made 429 while the account is serving: waiters time out behind a probe; re-check gates healthy accounts | 14.4k requests waited 2–5 s then 429 (tesote, 14 d); 03.1 itself read-only |

### B. High — wrong outcome for real traffic
| # | Fix in | `file:line` | Defect | Evidence |
|---|---|---|---|---|
| 10.4 | 05 + 06 | `services/translate/shared/structured-output.ts`; claude-fast request builder | Since 2.55.0 structured-output requests to Claude subs hang ~180 s then 400 "Schema is too complex"; `maxItems` rejected | Prod: 46 hangs + 13 rejects in 37.5 h. Regression candidate `4b47af8` |
| 12.1 | 01 (+02) | `apps/api/src/middleware/idleClock.ts:28-47` | Non-stream passthrough answers slower than ~60 s cut and filed `client_cancelled` | Prod: 512 in 14 d, Envoy `502 UPE` 38/38 matched. Mechanism unverified |
| 12.2 | 01 | `apps/api/src/main.ts:126-128` | Shutdown closes admission before the readiness grace → the grace is 20 s of 503 | Prod: 178 × 503 over 18 rollouts |
| 05.1 / 10.10 | 05 | `providers/claude-sdk/invoker.ts:157,171`; `credential-freshness.ts:257` | First request in a refresh window waits on its own claim for 20 s | Reproduced; prod: 5–13 requests stall at each expiry, wait timed out 7/7 |
| 02.3 | 02 | `services/dataplane/orchestrator.ts:309` | `count_tokens` estimate never releases its active-request lease; 65,536 of them close the data plane until restart | Reproduced in scratch |
| 04.1 | 04 | `providers/failure/classify.ts:192` + six driver rule files | Unanchored wording rules read echoed client text as a dead balance → healthy account `exhausted` (NN 7) | Classifier verified; vendor echo unverified |
| 07.4 | 07 | `services/usage/recorder.ts:137-158` | Batch discarded on second refusal: an outage > ~2 flush intervals deletes usage records | Prod (12.3). Reverses `docs/idea/08-observability.md:73-85` — owner ruling |
| 10.5 / 12.9 / 08.2 | 08 | `packages/db/src/repositories/usage-history-maintenance.ts:32-45` | Hourly backfill is a full anti-join under the lock that serializes usage writes | Prod: 28 % of all DB time, mean 3.1 s, max 8.6 s, 0 rows ever; 4.4 GB buffers/call on tesote |
| 01.1 | 01 | `services/dataplane/auth/verifier.ts:85-109,141-143` | Unknown-key spray evicts verified keys and queues Postgres lookups (NN 8) | Eviction reproduced |
| 01.2 | 01 (+08) | `services/admin-auth/localCredential.ts:96-105`; `service.ts:221-254` | Admin sessions cannot be revoked; live up to 30 days after password/allowlist change | Read; doc `07-security.md:358` false |
| 05.2 | 01 (composition) | `composition/request-services.ts:119-122`; `claude-sdk/account-ownership.ts:123` | Fast transport spawns two processes per request for the credential read | Measured 2.9 / 5.3 / 13.6 ms |
| 06.1 | 06 | `services/translate/sse/parse.ts:97-116` | SSE parser rescans the buffered partial line per chunk (quadratic) | Measured 637 ms for 1 MiB in 4 KiB chunks |
| 07.2 | 07 | `services/usage-read/summary-view.ts:57-76` | Usage summary labelling is O(rows × points) on the data-plane event loop | Measured 96 ms per dimension |
| 09.1 | 09 | `apps/web/src/lib/query.ts:21-33`; `components/Table.tsx:81` | Every poll rebuilds the whole screen; local UI state lost | Probed on `AccountsRoute`; `reconcile: "id"` fixes |
| 11.1 | 11 | `package.json:25` | 140+ test/bench files type-checked by nothing; ~131 hidden errors | Scratch `tsc` |
| 11.2 | 11 | `.github/workflows/release.yml:36-75` | Release publishes an image nothing built or tested before the tag | v2.55.0 built while `test` was still running |
| 13.1 | 13 | `docs/clients.md` | No error, retry or timeout contract for clients | Read |

### C. High — in other repos (file there, not fixed from this checkout)
| # | Repo | Where | Defect |
|---|---|---|---|
| 13.2 | `developerz-ai/developerz.ai` | `apps/runner/src/backend/preflight.ts:308-312` | Boot preflight posts `{}` to an inference route; an 8-min cadence means a restart-looping box (cause unverified) |
| 13.3 | `tesote/tesote.ai` | `apps/router/src/upstream/openrouter/upstream_error.rs:271-284`, `failover.rs:113-118` | 402/401 become a retryable 502; every 429/5xx silently moves to paid OpenRouter |
| 13.4 | `developerz-ai/developerz.ai` | `apps/runner/src/harness/loop.ts:630`, `packages/agent/src/providers/grade.ts:415` | SDK retries + key hops + uncapped redrives stacked on router failover |
| 13.5 | both consumers; router ask → 02 | see slice | Mid-stream router error loses its type (partly unverified, `sub`) |
| 13.6 / 12.7 / 10.18 | both infrastructure repos | `SHUTDOWN_DRAIN_MS=20000`, 1 replica, `Recreate` | 20 s drain vs 74–131 s stream p99: every roll cuts live requests (11 of 18 tesote rollouts hit the deadline) |

### D. Mediums promoted by production numbers
| # | Fix in | `file:line` | Defect | Evidence |
|---|---|---|---|---|
| 10.9 / 12.13 / 03.11 | 03 | `services/recovery/coordinator.ts:145-148` | Expired-permit lookup every 250 ms forever | 12.05 M calls, 64 % of all statements (dz); 4.2/s idle (tesote) |
| 10.8 | 07 (+03) | `scheduler/tasks/cooldown-recheck.ts:192-217` | Recheck reopens seats whose provider-reported weekly window is still spent | 51 reopenings in 37.5 h, each followed by real 429s. Mechanism unverified |
| 12.8 | 02 / 04 | owner of the 900 s clock unknown | Codex streams with zero output hold the client exactly 15 min | 119 in 14 d |
| 10.7 | 03 / 04 | see slice | opencode-go entitlement 403 treated as rejected credential, re-probed with live traffic → 502s | 11 upstream 403s |
| 10.6 | 02 | pre-dispatch rejection path | Nothing damps a client replaying one request: 30,924 identical 94 KB requests, 22 % of usage rows | Chains with 13.4 |
| 10.11 / 07.7 | 07 (+08) | `services/usage-read/` | Usage page runs ~20 raw-table aggregates per load, 140–490 ms each | Prod |
| 10.12 | 08 / 07 | `usage_contributions` | 68 % of a DB that grew 126 MB → 1,234 MB in five weeks; two-year horizon | Prod |
| 10.13 / 12.12 / 08.6 | 08 | `packages/db/src/schema/accounts.ts:177` | `accounts_last_used_at_idx`: 0 scans, makes every last-used stamp non-HOT | 306,422 non-HOT updates (dz); 6 HOT of 179,229 (tesote) |
| 12.10 | 04 / 07 | `plan_quota_read` | `partial` on every run since 2026-11-07; zai has no stored quota window | 384 of 415 runs |
| 10.3 | 01 | `logging/redact`; `account test failed` field `detail` | OpenRouter key-management URL with a 64-hex key hash logged verbatim (NN 3 — owner to rule whether a provider key hash is credential material) | 5 lines, Loki 30 d |
| 12.15 | 01 / 03 | router 429 log text | Carries account labels, one containing an operator email; 15,379 identical `translation dropped fields` warns | Whether the client body carries labels: not checked |
| 08.1 | 08 (+01 env) | `packages/db/src/client.ts:97` | No statement / lock / idle-in-transaction timeout on any pool | Read; 10.5 is heading for the 15 s admin timeout |
| 05.3 | 05 | `providers/claude-sdk/env.ts:35-61` | Subprocess env is a denylist; `USAGE_REPORT_DISCORD_WEBHOOK_URL` inherited | Read |
| 14.4 | 14 | `.dz/maintainer/maintainer.yml:21-22` | Stale close ignores `hitl`: #236, #210, #215 due to auto-close from ~2026-12-02 | Computed from the rule, not observed |

## Routed findings (evidence slice → owner slice)
The executor of a code slice also picks up these. Finding text, numbers and re-run commands stay in the evidence slice.

| Owner | Picks up |
|---|---|
| 01 | 12.1, 12.2, 12.3 (key lookup half), 10.3, 10.15, 10.21 (log level), 12.15, 12.18, 13.6 (drain sizing doc), 09-hints: `/assets/*` must 404 (`routes/spa.ts`), expired key cannot be renamed (`services/keys/mutations.ts:75`), server-side `next` validation |
| 02 | 10.2, 12.4 (scanner + metric split of recovery wait), 10.6, 12.5 (wait side), 12.8, 13.2 (token-free preflight / dedicated `{}` outcome), 13.5, 13.8 (`Retry-After` on router 503) |
| 03 | 10.7, 10.8 (rule), 10.9, 12.5, 12.13, 13.15, 09-hint: `?status=` filters the stored column before the live overlay |
| 04 | 10.1, 10.16, 10.17, 12.10, 13.15 (catalog context window) |
| 05 | 10.4, 10.10 |
| 06 | 10.4 (schema sanitizing), 13.17, 12.15 (dropped-fields warn volume) |
| 07 | 12.3 (usage half), 10.8, 10.11, 10.12, 12.14, 13.14, 13.16 (document `usage.cost` basis) |
| 08 | 10.5, 12.9, 10.13, 12.12, 10.14, 10.20; 11.1's stale-arity tests under `packages/db/test` |
| 09 | 10.11 (client side), 11.1's out-of-enum web fixtures |
| 11 | 13.7 + 11.15 (name the pin bump as a release step), 14-hint: `CONTRIBUTING.md:71-74` and `.claude/commands/feature.md:117` disagree with live branch protection |

## Work outside this repo
Not edited from this checkout. File an issue per row in the named repo; owner rulings go to `sebyx07` / `ivndev001`.

| Repo | Findings |
|---|---|
| `developerz-ai/infrastructure` | 13.6 / 10.18 (drain, replicas), 13.10 (uptime probe hits `/`, not `/readyz`), 13.11 (shared keys), 10.19 (README) |
| `tesote/infrastructure` | 12.6 (single zai seat → 38 % router-made 429s; critical alert fires on it), 12.7, 12.11 (alerts cover up/down only), 12.16, 12.17, 12.19, 13.11 |
| `developerz-ai/developerz.ai` (app + dz tooling) | 13.2, 13.4, 13.5, 13.9, 13.12, 13.13; dz tool causes of 14.2, 14.5, 14.8 (paths in slice 14) |
| `tesote/tesote.ai` | 13.3, 13.5, 13.16, 13.18 |
| Operator action, no code | 5 of 7 Claude subs on the developerz-ai router `needs_reauth` since 11-01…11-05; the two live ones at 0.98 / 1.00 of their weekly window (slice 10). Triage ledger in slice 14: close #335 and #138 as fixed, rule on #87 / #236 / the `archive/fleet-4/…` branch, rebase+merge #368 |

## Causal chains / cross-slice
1. **Spent seat → reopened → permit queue → router 429.** `cooldown_recheck` reopens a seat on any 2xx probe while its weekly window is spent (10.8) → real requests fail upstream and it cools again → each recovery publishes a pending permit → waiters get 5 s (`RECOVERY_REQUEST_WAIT_MS`) behind a probe that takes 21 s on a slow provider (12.5) → 429 after the wait. Shows up as the pre-dispatch p95 4,023 / p99 5,014 ms (slice 10 baseline) and the 250 ms grid in passthrough p99 (12.4). 03.1 is the same gate triggered by the operator. The link 10.8 → 12.5 is inferred from two clusters, not traced in one request — confirm before treating as one fix.
2. **Overhead is four costs added together.** Body scanner (02.1) + response framing/observer (02.2 ≡ 07.1) + request Zod parse on translate (06.2) + credential-read subprocesses on fast mode (05.2), plus recovery waits wrongly counted in the metric (12.4). `bin/bench` uses 1 KB prompts and 5-byte answers (02.13), so the gate never saw it. Fix 02.13 first so each fix is measured.
3. **Postgres blip → 500s + lost usage.** Key cache expiry puts the lookup on the request path (01.8), unknown keys can evict warm ones (01.1), the failure surfaces untyped (12.3), and the usage writer drops batches on the second refusal (07.4). One incident, three slices.
4. **Kimi misclassification is two defects in one file.** 10.1 (type rule fires before the window wording) is live now; 04.1 (unanchored wording on any status) is the latent, wider form. Fix together in `providers/failure/classify.ts` + driver rule files; then the bounded re-test stops flapping the account.
5. **Rollouts.** Admission closes before the grace (12.2) + 20 s drain vs minute-long streams (13.6, 12.7, 10.18) + one tag per PR (64 release runs in 26 days, 14-hint) = frequent, client-visible cuts. Consumers built failover around it (13.3 moves tesote chat to paid OpenRouter; 13.4 stacks retries), which in turn produces replay load (10.6).
6. **2.55.0 structured output.** 13.7 said consumers keep a probe hold for a fast-path 400 that 2.55.0 fixed; 10.4 shows 2.55.0 introduced hangs on the same path. Do not ask consumers to drop the hold until 10.4 is fixed and re-measured.
7. **Backfill.** 08.2, the 07 hint, 10.5 and 12.9 are one defect; it also explains the `router_usage_admission_seconds` tail (15 flushes over 5 s in 24 h).
8. **A stray rejection is a process exit.** No `unhandledRejection` handler (01.5); a throwing `onTick` permanently disarms a task timer (07.10); scheduler has no run deadline (07.5). Land 01.5 before the others.

### Duplicates resolved
| Kept | Folded in | Why |
|---|---|---|
| 07.1 | 02.2 | fix's file is `services/usage/` |
| 08.2 | 10.5, 12.9, 07 hint | repository file |
| 08.6 | 10.13, 12.12 | schema + migration |
| 03.11 (raise to medium) | 10.9, 12.13 | coordinator file; prod numbers promote it |
| 05.1 | 10.10 | invoker file |
| 12.2 | 13.6 (router half), 10.18 | `main.ts` |
| 03.10 | 01 hint on `/readyz` | health file; env key via 01 |

### Contradictions resolved
- **13.7 / 11.15 "prod trails the tag" — falsified.** Both pods run 2.55.0; the pins were read from stale local checkouts. Both findings are corrected in place and downgraded to the process/README gap.
- **01 "idle clock checked, not a bug" vs 12.1.** The code reads correct; prod shows the hold not taking effect on one path. Annotated in slice 01; 12.1 stands as an open defect with an unverified mechanism.
- **Slice 10 summary said 5 highs; its file has 4** (10.3 is medium in the file). Counts here follow the files.

## Done when
- Every finding in slices 01–09, 11, 14 is fixed with its test (failure case first), or closed in its slice with a one-line reason and `status.yml` updated.
- `bin/check` green with `DATABASE_URL`. `bin/bench` extended per 02.13 (prod-shaped 300–400 KB body) and passing: passthrough p99 < 5 ms at that size.
- The host-tool security gate (`apps/api/test/integration/claude-sdk-security.test.ts`) untouched and green; 05.9's enumeration gate added.
- One migration `0044` only, applied clean on a fresh DB and on a copy of prod shape.
- `docs/idea/*` updated in the same PR as each behaviour change; every line under "Doc claims falsified" in every slice resolved; `CHANGELOG.md` + version bumped.
- After the release is live on both clusters, re-run the **Re-run** queries of section A, B and D and record the new numbers next to the baselines in slices 10 and 12: no `exhausted` park on a Kimi window 429; zero generic 500s; overhead p99 within budget excluding the labelled SDK path; backfill off the top of `pg_stat_statements`; recovery poll no longer the top statement by calls.
- An issue exists in each external repo for every row of **Work outside this repo**.

## Risks / open questions
Owner rulings needed (`sebyx07` / `ivndev001`) before the executor acts:
- **07.4** — keep-and-retry usage batches through an outage reverses the documented drop decision (`docs/idea/08-observability.md:73-85`).
- **06.4** — undecodable tool arguments: fail the response instead of `input: {}`; reverses the comment at `openai-chat-to-anthropic/response.ts:121-129`.
- **02.4** — narrow forced-tool coercion so it does not buffer when the vendor obeyed; revisits the v2.37.4 decision.
- **03.7** — a thrown exhausted re-test should not advance the doubling clock; a unit test encodes the opposite.
- **10.3** — is a provider key hash credential material under NN 3?
- **06.9, 04.9, 05.14** — prior decisions flagged as questionable in their slices.
- **13.6** — two replicas with rolling updates needs a ruling on in-memory state (health maps, rate limiter per replica, exhausted ladder 07.6) and the per-Account `CLAUDE_CONFIG_DIR` volume.
- **14 ledger** — closing #87 / #236 and deleting the archive branch.

Risks:
- Migration `0044` builds indexes on `usage_records` / `usage_contributions` (SHARE lock) at boot; on the 840 MB table this blocks usage flushes for the build. Confirm flushes queue and are not dropped (07.4 makes this worse until fixed) — or build `CONCURRENTLY` outside the transaction.
- Several perf figures are single-machine micro-benchmarks; prod confirms the totals (10.2, 12.4) but not each component's share. Profile before choosing the order within chain 2.
- 12.1, 10.8, 12.5, 12.8 have confirmed fingerprints and unverified mechanisms. Reproduce first; do not ship a guess.
- Findings marked `sub` in slice 13 came from delegated passes not re-read by the auditor.

## Not covered
- **OAuth connect flow** (`services/accounts/connect/`: state, PKCE, one-shot, TTL, token logging) — slice 03 read it in part, slice 04 excluded it. Unaudited.
- Tests were skimmed by name in most slices, not read for wrong-rule encodings (beyond those cited).
- No `EXPLAIN` plans (dev Postgres down; prod used `pg_stat_statements` instead). No index bloat estimate.
- GlitchTip/Sentry events; logs of pods before the current ones (beyond targeted searches); `Retry-After` header values; request bodies.
- Web: no visual, contrast or light-theme pass; probes ran under happy-dom.
- Devex: `bin/setup`, `bin/dev`, `bin/check`, the full suite and `docker build` were not run; image size unmeasured.
- Consumers: app code of the discord bot, legald writer, notificado KYC and tesote marketing.
- dz platform audit log — the `developerz` MCP server returned 401; `db-mcp-gateway` likewise.
- `4fantasia-router` is a different product (Rust gateway), not this image; not covered.
- Per-slice gaps are listed at the foot of each slice.
