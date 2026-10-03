# 02 — Routing, account state & persistence

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/routing/**`, `apps/api/src/services/catalog/**`, `apps/api/src/services/accounts/{recheck.ts,refresh/**,connect/oauth-exchange.ts,connect/fromEnv.ts}`, `apps/api/src/services/dataplane/{health.ts,health-reading.ts,probe.ts,snapshot.ts,chain.ts,quota-writer.ts}`, `apps/api/src/services/cost/**`, `apps/api/src/scheduler/**`, `packages/db/src/repositories/{account-repository.ts,usage-daily-repository.ts}`, `apps/api/src/composition/admin.ts` (wiring lines only).

## Findings

**Replica stance.** Prod runs 1 replica. The spec targets N (`docs/idea/01-architecture.md:234`, `09-deployment.md:112,180` assume several replicas share a DB). Multi-replica-only findings keep their severity but are marked **[N>1]**: 02.2, 02.1(b), 02.9, 02.10.

**Rank (most severe first; ids stable):** 02.14 · 02.1 · 02.3 · 02.2 [N>1] · 02.4 · 02.7 · 02.5 · 02.6 · 02.15 · 02.11 · 02.12 · 02.16 · 02.8 · 02.17 · 02.9 · 02.10 · 02.13 · 02.18

### 02.1 high — In-memory `exhausted` / `needs_reauth` verdicts are sticky per replica; reconnect and Re-check don't reach them
- **Where:** `services/dataplane/snapshot.ts:39-42` (breaker status wins over row unless row is `disabled`/`needs_reauth`); `services/dataplane/health.ts:258-271` (`phase === "blocked"` never expires); `services/accounts/connect/oauth-exchange.ts:114-156` + `connect/fromEnv.ts:164` (OAuth completion: row → `active`, no `health.reset`, no `refreshCatalog`); `services/accounts/refresh/status.ts:53-67` (`reviveAfterRefresh`, no `health.reset`); `services/accounts/recheck.ts:134` and `connect/claude.ts:272` (`health.reset` hits the local replica only).
- **Defect:** a blocked breaker verdict lives in one process's memory forever; only a local `health.reset` clears it, and the ChatGPT/Codex OAuth reconnect + refresh-revive paths never call it, and no path clears it on other replicas.
- **Failure scenario:** (a) single replica: `openai-oauth` account gets a `401` → breaker `needs_reauth` (`breaker.ts:146-155`) → operator completes reconnect → row `active` but `overlayHealth` still says `needs_reauth` → every request 503 "needs re-auth" until someone also presses Re-check or the pod restarts. (b) 2 replicas: both saw a `402` → both breakers `exhausted`; operator presses Re-check (served by A) → row + A cleared; B keeps `exhausted` until restart — ~half of traffic still answers `402 needs top-up`. Same for a Claude re-login on A.
- **Fix:** make the row authoritative for *clearing*: record `blockedAt` in `BreakerState` when `recordFailure` lands in `blocked` (`breaker.ts`), carry the row's `updatedAt` on `AccountSnapshot` (`catalog/load.ts:95`), and in `overlayHealth` ignore a breaker block whose `blockedAt` < row `updatedAt` while the row says `active` (status-writer writes the block itself, so the row's own write is never newer than the verdict it persisted — compare `>`, not `>=`). Also call `health.reset` + `refreshCatalog` from the OAuth completion (`oauth-exchange.ts:155` via `connect/fromEnv.ts`) and from `reviveAfterRefresh`'s caller (`refresher.ts:191`), so the local replica clears immediately.
- **Test:** unit (pure) `snapshot.test.ts` — breaker `{status:"exhausted", blockedAt:T}`, row `active` updatedAt T+1 → overlay `active`; row updatedAt T-1 → `exhausted`. Integration: Codex account answers 401 → reconnect via `/connect/complete` against a mocked token endpoint → next request routes to it, `UsageRecord` outcome success.

### 02.2 high [N>1] — OAuth refresh isn't single-flighted across replicas; a rotating refresh token gets spent twice and the loser parks a healthy account
- **Where:** `services/accounts/refresh/refresher.ts:20-27` (no lock by design), `:244-253` (`refreshNow` single-flight is per process), `refresh/exchange.ts:51-114` (reads `authMaterial`, unconditional `update`), `refresh/status.ts:28-49` (`parkForReauth` unconditional `updateStatus` from a stale row).
- **Defect:** every replica arms its own timer for every OAuth account and refreshes independently; with refresh-token rotation (OpenAI) the second presenter of the same refresh token is refused → `"refused"` → `needs_reauth` written over the row the winner just refreshed.
- **Failure scenario:** rolling deploy boots replicas A and B within a second → `refreshDueAt` (`schedule.ts:35-39`) ≈ same instant → both read refresh token R1 → A gets R2 and writes it; B's request with R1 → 400 `refresh_token_reused` → `parkForReauth` writes `needs_reauth` + audit → account out of routing on every replica (status-writer guard doesn't apply here; this path is unconditional). Worst case the issuer revokes the whole token family and the account really is dead. Steady state also costs N refreshes per lifetime for N replicas.
- **Fix:** wrap `attempt()` (`refresher.ts:222`) in `withAdvisoryLock` keyed by `advisoryLockKey("oauth_refresh:"+accountId)` (needs a `TaskLock`-like capability injected, not a raw connection); lock lost → re-read the row and re-arm from its `tokenExpiresAt`. Inside the lock, re-read the row and skip if `tokenExpiresAt` moved since the timer was armed. Make the write CAS: `update … where id = ? and auth_material = <held ciphertext>`; zero rows → someone else refreshed, re-arm, no park. Make `parkForReauth` use `updateStatusWhen(id, ["active","cooling_down"], "needs_reauth")`. Update `docs/idea/01-architecture.md:329`.
- **Test:** unit with two refreshers sharing a fake repo + a token endpoint that rotates and rejects reuse: both fire → exactly one exchange, no `needs_reauth`. Unit: CAS miss → no park.

### 02.3 high — Re-check / Claude re-login hand the account back as fully `active`, not as one half-open probe
- **Where:** `services/accounts/recheck.ts:8-27,134` (claims "eligible again as a half-open probe… exactly one request is admitted"); `services/dataplane/health.ts:315-318` (`reset` deletes state → `FRESH`, `status: active`); `services/routing/filter.ts:123` (`halfOpen` only when `status === "cooling_down"`); `dataplane/probe.ts:53` (non-half-open bypasses the gate).
- **Defect:** after `reset`, the breaker is `HEALTHY`, so the account is a normal candidate — no probe gate, no ranking behind healthy members; the whole backlog lands on it.
- **Failure scenario:** 3-account pool, account C `exhausted` (still unfunded) → operator presses Re-check → under 50 rps, every request in the next RTT routes to C per policy (round-robin: ⅓ of all traffic) → burst of `402`s, each failing over (extra latency + upstream calls) until the first `402` re-marks it. For a `cooling_down` account, same burst of `429`s into an upstream that just rate-limited us — the stampede `probe.ts` exists to prevent.
- **Fix:** `HealthStore.reset` should install `{status:"cooling_down", cooldownUntil: now, cooldownSource:"estimated", consecutiveFailures: prev}` (a cooldown that has just expired = half-open) instead of deleting, plus clear `probeHeldUntil`; overlay must let that win over a row `active`. Keep account-deletion using a true delete (`forget`). Same for `connect/claude.ts:272`.
- **Test:** unit: `reset` then `evaluateCandidate` → `halfOpen: true`; two `admitProbe` calls → one admitted. Integration: recheck exhausted account, fire 5 concurrent requests at a mocked 402 upstream → exactly one attempt on it.

### 02.4 medium — Losing the half-open race returns `503 no_healthy_account` with no `Retry-After` and writes no `UsageRecord`
- **Where:** `services/dataplane/chain.ts:107-112` (refused probe removed from `ordered`), `:262-267` (`NoHealthyAccountError("no candidate account could be attempted")`, status 503 per `packages/core/src/errors.ts:55-58`); `orchestrator.ts:220-246` (runChain throw is not routed through `fail`, so no row).
- **Defect:** a request whose only candidate(s) were half-open probes already taken by a concurrent request ends as a generic 503 instead of the `probe-in-flight` 429 the filter would have produced one snapshot later; and no usage row is written (CLAUDE.md Testing: row per request incl. failures).
- **Failure scenario:** 1-account pool cooling down; 20 queued clients retry at the reset instant → all build snapshots before the first `admitProbe` → 1 admitted, 19 get `503` (clients treat as hard error, not back-off) and none appear in usage. Same with every member half-open.
- **Fix:** in `chain.ts` collect refused probes as `RejectedCandidate { reason: "probe-in-flight", resetsAt: health.stateOf(id).probeHeldUntil }`; when the loop ends with `held === null && lastFailure === null` and refusals exist, throw `noCandidatesError`-equivalent `QuotaExhaustedError` with `Retry-After` (reuse `routing/no-candidates.ts` `quotaError` via an exported helper). Write a preflight-style `attemptRecord` (outcome from `outcomeOf(error)`) before throwing — expose `fail` to the chain or catch in `orchestrator.ts:220`.
- **Test:** integration: stub health with account half-open, pre-take the hold, dispatch → `429`, `Retry-After` ≈ hold expiry, one `UsageRecord` with `accountId` null and `errorClass` quota.

### 02.5 medium — Catalog refresh after an admin write can join a stale in-flight load (read-after-write broken)
- **Where:** `services/catalog/store.ts:60-71` (`inFlight ??=`), same pattern `services/cost/book.ts` `refresh`; consumers `services/admin/coherence.ts:59-63`, `accounts/recheck.ts:183`.
- **Defect:** a refresh requested while the jittered timer's load is in flight returns that load, whose SELECTs may predate the admin write's commit.
- **Failure scenario:** timer refresh starts at t0 and reads `accounts`; operator disables account X, UPDATE commits at t0+3 ms, `refreshCatalog()` returns the t0 promise → snapshot still has X `active` → X keeps routing for up to `CATALOG_REFRESH_SECONDS` (30 s default) despite the console reporting success. Same for removing a pool member, revoking scope via pool edit, a price override.
- **Fix:** generation counter: `refresh()` records `requested = ++gen`; if a load is in flight that started before `requested`, chain one more load after it (coalesce all waiters onto that follow-up). Apply to both `catalog/store.ts` and `cost/book.ts`. Update `docs/idea/01-architecture.md:240`.
- **Test:** unit with a `load` you resolve manually: start load A, call `refresh()` again, mutate source, resolve A → second promise resolves only after load B, data reflects mutation.

### 02.6 medium — Daily rollup double-counts failover requests across accounts
- **Where:** `packages/db/src/repositories/usage-daily-repository.ts:226` (`count(distinct correlation_id)` per `(day,key,account,pool,model)` group), summed again at `:154` (`totals`) and `:173-180` (`breakdown`); raw path counts distinct once over the window (`usage-read-repository.ts:350`).
- **Defect:** a request whose chain touched N accounts appears in N groups, so closed-day `requests` = Σ per-account distinct ≥ true requests; same for key/pool/model breakdowns.
- **Failure scenario:** 1,000 requests, 200 of which failed over once → today (raw) shows 1,000, yesterday (rollup) shows 1,200 for the same traffic; a window spanning both mixes the two definitions; failure-heavy days look busier.
- **Fix:** attribute each request to exactly one group: count `requests` only on the row with `max(attempt)` per correlation id (e.g. `count(distinct correlation_id) filter (where attempt = (select max …))`, or a window function in a CTE `row_number() over (partition by correlation_id order by attempt desc) = 1`). Recompute existing rows: the rollup only revisits yesterday/today, so document a one-off backfill (`rollupDay` over `[floor, today]`) — no migration needed.
- **Test:** integration (DB): insert 3 attempt rows (accounts A,B,C) sharing a correlation id → `rollupDay` → `totals.requests === 1`, `attempts === 3`, breakdown by account sums to 1.

### 02.7 medium — 06.2: every Kimi success is `cost_basis = unknown` — the `kimi` provider is the coding surface, priced against the Moonshot *platform* table
- **Where:** `providers/drivers/kimi.ts:11-20` (`kimi` = `https://api.kimi.com/coding`, "own model ids (`k3`)", accounts typically alias `sonnet` → `k3`); `services/cost/prices.ts` `PRICES.kimi = MOONSHOT_MODELS`; `services/cost/tables/moonshot.ts` keys are platform ids only (`kimi-k3`, `kimi-k2.6`, `kimi-k2.5`, `moonshot-v1-*`), and `kimi-k2*` are left out on purpose; `services/dataplane/records.ts:124-133` prices `upstreamModel`; `services/cost/rates.ts` `modelLookupKeys` only strips a date suffix.
- **Defect:** corrected premise: prod rows are provider `kimi`. Pricing looks up the post-alias upstream name (`k3`, `k2`, …, or an unaliased client name such as `claude-sonnet-*` passed through). None of those is a key in `MOONSHOT_MODELS`, so `lookupRates` returns null → `UNKNOWN_COST`. The table describes `platform.kimi.ai`, a surface no `kimi` account calls. Exact served ids are `unverified`: run `select upstream_model, model, count(*) from usage_records where provider='kimi' group by 1,2`.
- **Failure scenario:** 63 of 63 Kimi successes are `unknown`, so the notional-spend panels show nothing for the only traffic in the window. The same happens to every future Kimi account.
- **Fix:** (1) Ops now: add `price_overrides` rows for `(kimi, <each served upstream_model>)`. The book honours them (`book.ts` lookup). (2) Code: add a coding-surface section to `tables/moonshot.ts` that maps the coding ids the driver documents (`k3` → the `kimi-k3` card, plus each served `k2*` id → its platform card), with a provenance comment saying it is a notional attribution for a flat plan. Alternatively give `kimi` its own `KIMI_CODING_MODELS` table in `prices.ts`. Unaliased foreign names (`claude-*`) stay `unknown`, which is the honest answer. (3) Secondary, not prod-visible: `openai-compatible` and `anthropic-compatible` have no table at all. Two compatible accounts (Alibaba, plus any future one) also share one override namespace keyed by provider, which assumes one account per provider. A per-account price alias needs a migration, so defer it to #138.
- **Test:** unit `prices.test.ts`: `lookupRates("kimi","k3")` is non-null and equals the `kimi-k3` card. Each id observed in prod is non-null. `lookupRates("kimi","claude-sonnet-4-5")` is null.

### 02.8 low (real path, not triggered in prod) — A spent window with no reset blocks an account forever, and nothing clears it (06.6, Claude `seven_day = 1`)
- **Prod check:** both Claude `seven_day = 1` rows carry `resets_at` (2026-10-05 14:59:59Z, 2026-10-08 14:00Z), `provider-reported`. That is the intended representation: `status` holds standing blocks only, the window holds the quota, the filter returns 429 until the reset, and `isWindowSpent` lets it go once the reset passes. The code path below is real but needs the SDK to report a spent window without a reset.
- **Where:** `services/routing/quota.ts:31-36` (`utilization ≥ 1` and `resetsAt === undefined` → spent, indefinitely); `providers/claude-sdk/quota-reading.ts:72,149` (`futureEpoch`/`futureIso` turn a past or absent reset into `null`); `scheduler/tasks/quota-floor.ts:117-119` (only clears rows whose `resetsAt` is non-null).
- **Defect:** a reading of `utilization=1` whose reset was absent or already past is stored/held with no `resetsAt`; `isWindowSpent` then says spent forever and the floor's predicate can never select it — a clock-recoverable state with no clock and no human-visible `exhausted`.
- **Failure scenario:** prod: two Claude subs show `seven_day utilization=1`, `status=active`. That pairing *is* the intended representation (status holds only standing blocks; the window row carries the quota and `findSpentWindow` drops the account as `quota-window-spent` → 429). But if those rows have `resets_at IS NULL` (`unverified` — run `select account_id, window, utilization, resets_at, last_checked_at from quota_windows where utilization >= 1`), the accounts are out of routing permanently with `Retry-After` = the 30 s unknown floor forever.
- **Fix:** treat `utilization ≥ threshold` with no `resetsAt` as spent only while `lastCheckedAt` is within a configured staleness bound (new env `QUOTA_UNKNOWN_RESET_STALE_MINUTES`); in `quota-floor.ts` also clear rows with `resetsAt null` whose `lastCheckedAt` is older than that bound. Never synthesize a reset instant.
- **Test:** unit `quota.test.ts`: window `{utilization:1, lastCheckedAt: now-2h}` with bound 60 m → not spent; `now-10m` → spent. Unit quota-floor with such a row → cleared to `none/unknown`.

### 02.9 low — 06.6: metered/compatible cooldowns are memory-only (confirmed, by design) and invisible across replicas
- **Where:** `services/dataplane/status-writer.ts:45-60,95` (`persistable` = `exhausted|needs_reauth` only); `health.ts:296-299` (`onQuotaWindows` fires only when a signal carries named windows — HTTP drivers never do).
- **Defect:** not a correctness bug: `kimi`/`alibaba` `cooling_down` lives in the breaker only; restart forgets it and costs one `429` per replica per account to re-learn (documented trade-off). Real gap: the console overlays *its own* replica's health, so with >1 replica an operator may see `active` for an account the other replica is cooling.
- **Fix:** no code change for routing. Optional: render "cooldown observed on this replica" in the accounts view; spec note in `docs/idea/05-routing-and-failover.md` that cooldowns are per-replica.
- **Test:** none required; existing status-writer tests cover the exclusion.

### 02.10 low — Concurrent writers clobber fresher quota rows (quota-writer across replicas, quota-floor vs live reading)
- **Where:** `packages/db/src/repositories/account-repository.ts:369-388` (unconditional `onConflictDoUpdate`); `dataplane/quota-writer.ts` drain; `scheduler/tasks/quota-floor.ts:89-101` (reads windows, then writes `none/unknown` later without re-checking).
- **Defect:** last write wins regardless of `lastCheckedAt`, contradicting `routing/quota.ts:111-133` ("the fresher `lastCheckedAt` wins").
- **Failure scenario:** replica B serves account X, writes fresh `five_hour` (resetsAt 17:00) at 12:00:01; floor on A (where X looks idle) read the expired 12:00 row at 12:00:00 and upserts `none/unknown` at 12:00:02 → stored reading lost; other replicas/console after restart show no gauge. Same with two quota-writers flushing out of order.
- **Fix:** add `where: sql\`excluded.last_checked_at >= ${quotaWindows.lastCheckedAt}\`` to the upsert's `onConflictDoUpdate`; in quota-floor additionally guard on the `resets_at` it read (`and resets_at = $read`) — a separate `clearExpiredQuotaWindow(accountId, window, readResetsAt, now)` repo method.
- **Test:** DB integration: upsert newer then older → newer stays; floor clear after concurrent fresh write → fresh row stays.

### 02.11 low — Opt-in billed idle probe spends turns on `exhausted` / `needs_reauth` accounts on a timer
- **Where:** `packages/db/src/repositories/account-repository.ts:348-366` (`findIdle` excludes only `disabled`); `scheduler/tasks/idle-account-probe.ts:212-232`; warm path `:173-191` also runs for `exhausted` subs.
- **Defect:** with `IDLE_ACCOUNT_PROBE_PAID_TURN=true`, a dead-balance account (never used, so always idle) gets a real request every tick — literally "retry an `exhausted` account on a timer" (CLAUDE.md NEVER). It changes no status, so not a routing bug, but it bills/hits a dead account forever.
- **Fix:** `findIdle` → `notInArray(status, ["disabled","exhausted","needs_reauth"])`; skip `exhausted` in the warm loop.
- **Test:** unit task test: idle list containing an `exhausted` row → `test` never called for it.

### 02.12 low — Honored binding to a pool's overflow account is silently dropped when members recover
- **Where:** `services/routing/select.ts:96-100` (overflow only used when the group filters empty) vs `binding.ts:64-68` (`findInScope` admits overflow → `honored`); `select.ts:78` `hoist` no-op; `failover.ts:265-269` `leavingBound` false.
- **Defect:** binding reported `honored`, yet the bound account isn't in `candidates`; request starts a fresh SDK session on a member with no `session-restart` signal and the binding isn't invalidated.
- **Failure scenario:** pool members all cooling → overflow Claude sub serves session S (bound) → members recover → next turn of S goes to member M, prior turns gone, client not told (`06-protocol-translation`/`session-restart.ts` promise broken). Only when overflow is a subscription.
- **Fix:** in `selectAccounts`, when `binding.state === "honored"` and the bound id is a group's overflow not in `ordered`, push the evaluated overflow candidate and hoist it (it passed `evaluateCandidate`).
- **Test:** unit `select.test.ts`: pool {A eligible, overflow O eligible}, binding O → `candidates[0].account.id === "O"`.

### 02.13 low — `RETENTION_USAGE_DAYS=1` loses the last pre-midnight interval from the rollup
- **Where:** `scheduler/tasks/usage-rollup.ts:146-153` (floor = `startOfNextUtcDay(now - usageDays)`); env allows `atLeastOne` (`config/env.ts:753`).
- **Defect:** with 1 day retention the floor is today 00:00 after midnight, so yesterday is never re-closed; records written after its last tick (≤ one interval) never reach `usage_daily`.
- **Fix:** require `RETENTION_USAGE_DAYS ≥ 2` in env validation, or let the floor admit yesterday while its raw rows still exist (cutoff mid-yesterday means partial — so the env bound is the honest fix).
- **Test:** unit env test: `RETENTION_USAGE_DAYS=1` rejected.

### 02.14 high — Scheduler reserves a whole pooled connection per running task. With `DB_POOL_MAX` ≤ the number of due tasks, the pool deadlocks
- **Where:** `packages/db/src/advisory-lock.ts:101-112` (`sql.reserve()` held for all of `work()`); `scheduler/runner.ts:113-118` (`repo.begin`, `task.run`, and `repo.finish` all run on the **shared** pool, not on the reserved connection); `runner.ts:197-216` (`scheduleFirst`: an overdue task gets `delayMs = 0`, and `jitter(0)` is 1 ms, so every overdue task fires together); `scheduler/tasks/index.ts:166-265` registers up to 9 tasks; `packages/db/src/client.ts:68` defaults `max: 10`. In postgres.js a reserved connection leaves the pool until it is released (`postgres/src/index.js:203-221`), and a `reserve()` call with nothing free waits in the queue.
- **Defect:** each running task removes one connection from the pool and then needs another to do its work. With K tasks running concurrently, K ≥ `DB_POOL_MAX` means every connection is reserved while each task waits for a free one, so nothing ever completes.
- **Failure scenario:** the operator lowers `DB_POOL_MAX=5` (the doc at `docs/idea/09-deployment.md:112` suggests lowering it for shared instances). The pod restarts after a few hours down, so all 9 tasks are overdue and fire within 1 ms. 5 reservations succeed, the other 4 wait in the reserve queue, and the 5 holders' `repo.begin` inserts wait for a connection that never frees: a permanent deadlock. Collateral damage:
  - Usage/quota/status writers stall and the usage queue sheds rows.
  - Admin console queries hang.
  - Session-binding cache misses (`session-binding.ts:43` → `store.binding` → `findByKey`) hang subscription requests.
  - `scheduler.stop()` awaits in-flight ticks, so shutdown hangs too.
  - `/readyz` behaviour is `unverified`.

  At the default 10 the same boot burst leaves 1 connection for everything, and `idle_account_probe` holds its reservation for minutes while it spawns subprocesses.
- **Fix:** stop reserving a session for the length of the work. Either (a) take a transaction-scoped `pg_try_advisory_xact_lock` inside a short `sql.begin` that only claims a lease row (`scheduled_task_runs` begin with `on conflict` / lease-until column, which needs a migration), or (b) keep session locks on a **dedicated** small lock pool (`max: 1`-per-task, separate `createDatabase` handle sized to the task count) so work never competes with lock holders. (b) needs no migration. In the same change:
  - Stagger the first ticks: `delayMs = max(delayMs, index * spread)` in `scheduleFirst`.
  - Refuse boot when `DB_POOL_MAX` ≤ the number of registered tasks, or document the coupling in 09-deployment.md.
- **Test:** unit (runner with a fake `TaskLock` that models a pool of N): 9 tasks due at once with N=5 all complete. Integration (DB): `createDatabase({max:3})`, 4 overdue tasks, `runNow` on all → each settles within a timeout.

### 02.15 medium — A half-open probe that fails with a 5xx or timeout below the failure threshold leaves the account half-open, so the next request probes again
- **Where:** `services/routing/breaker.ts:172-178` (default branch: `failures < threshold` → `{...state, consecutiveFailures}`, which keeps the expired `cooldownUntil`); `dataplane/chain.ts:244` releases the hold after the verdict.
- **Defect:** a cooldown tripped by a `429` sets `consecutiveFailures = 1`. When its probe answers 503, that becomes 2, below the default threshold of 3. The status stays `cooling_down` with an instant already in the past, so the breaker is still half-open and the probe gate reopens at once. This contradicts the spec's "Failure → cooling_down at the next backoff step" (`breaker.ts:8`).
- **Failure scenario:** the account is rate-limited (count 1) and the reset passes. Probe 1 gets a 503, so the account is still eligible, and probe 2 immediately gets another 503. Only the third failure re-trips it. Every failed probe below the threshold costs a client attempt plus failover latency, and the spec promises one probe per cooldown.
- **Fix:** in `recordFailure`'s default branch, when `phase(state, now) === "half-open"`, always `trip(...)`, skipping the threshold. Same in the `rate-limited` branch (it already trips).
- **Test:** unit `breaker.test.ts`: from `{cooling_down, until: now-1, failures:1}` a `server-error` gives `phase === "open"` with `cooldownUntil > now`.

### 02.16 low — Crashed or killed task runs are never swept and read as running forever
- **Where:** `packages/db/src/repositories/scheduled-task-repository.ts` `deleteOlderThan` (`narrowedBy: isNotNull(finishedAt)`); `scheduler/runner.ts:113-118` (opens the row before the work, closes it after).
- **Defect:** a run whose process died between `begin` and `finish` keeps `finished_at IS NULL` forever. The janitor skips it on purpose, so these rows accumulate one per crash or OOM kill or deploy kill mid-sweep. `lastRun` ignores them once a newer row exists, but the settings screen can still list a stale "running" row.
- **Fix:** in the janitor, also sweep `finished_at IS NULL and started_at < cutoff`. Better, close orphans: `update … set outcome='failed', error='abandoned', finished_at=now where finished_at is null and started_at < now - (interval*2)`, run under the task's own lock at the start of each tick (`runner.ts:113`).
- **Test:** DB integration: open row with `started_at` older than retention gets deleted. An orphan older than two intervals is closed as `failed` on the next tick.

### 02.17 low — 02.4 extended: the zero-attempt `runChain` exit is the only path that writes no `UsageRecord`
- **Where:** `dataplane/chain.ts:262-267` and `orchestrator.ts:220`.
- **Defect:** I traced every exit. A `bodyFor` throw, a dispatch throw, and an upstream failure all call `recordAttemptFailure`. Only "every candidate was a refused half-open probe" leaves the loop with `lastFailure === null`, and only that exit throws without a row. One more variant: if probes are refused after earlier attempts already failed, `held` is set and the right error surfaces, but the refused accounts never appear in its message.
- **Fix:** covered by 02.4. Additionally, in `orchestrator.ts` wrap `runChain` so that any throw where `runtime` recorded zero attempts goes through `fail()`. The guard stays generic, so a future zero-attempt exit cannot regress.
- **Test:** as in 02.4, plus a counter on `runtime.record` showing at least 1 row for every dispatch outcome.

### 02.18 low — Rollup "closed day" boundary uses the app clock while `created_at` uses the DB clock
- **Where:** `usage-rollup.ts:85-99` (days from the tick's `now`); `usage-read/rollup.ts:44-52` (`closedEnd` from `lastRollupAt` = app `startedAt`); `usage_records.created_at` `defaultNow()` (`schema/usage-records.ts:149`, DB time).
- **Defect:** with the app clock ahead of Postgres by s seconds, a tick just after app-midnight closes "yesterday". Rows inserted in DB time `[23:59:60-s, 24:00)` land in yesterday after it was rolled, and the read service already treats yesterday as closed, so they are missing until the next tick re-closes yesterday (≤ one interval). This is transient, never permanent, because yesterday is always re-rolled.
- **Fix:** stamp `created_at` from the app (`startedAt`/`finishedAt` of the attempt are already on the row; bucket on `finished_at` in the rollup and in raw reads), or read `now()` from the DB for the cursor. No migration needed if the bucket column switches to `finished_at` (it is nullable, so `coalesce(finished_at, created_at)`).
- **Test:** unit `rollupFrom` and `splitWindow` with a skewed `now`, asserting yesterday stays raw-read until a tick starts after `startOfUtcDay(now)+skewBound`.

**Checked and clean (no finding):**
- Advisory lock lock/unlock on the same reserved connection (`advisory-lock.ts:101-112`). postgres.js defers `max_lifetime`/`idle_timeout` termination while a connection is reserved (`connection.js:413-418`), so a long hold is not cut.
- Task overlap: `runner.ts:156-169` single in-flight per task, rescheduled only after settle. Across replicas the lock gives `skipped_locked`.
- Rollup double-run and partial batches: whole-day replace upsert (`usage-daily-repository.ts:200-246`). Late rows land by insert time and yesterday is always re-closed.
- Janitor vs rollup: the rollup floor is `startOfNextUtcDay(now - usageDays)`, and the raw cutoff falls inside the excluded day.
- Usage windows are UTC-only. No DST bucket math exists (the console has no local-timezone windows; noted under Not covered).
- Weighted policy: all weights 0 falls back to rotation with a note; weight 0 in a mixed pool goes to the tail only (failover reach kept); ties break deterministically by declared order and then id. Fair over the counter modulo the weight total.
- Half-open gate: `admitProbe` is a synchronous compare-and-swap on one event loop; the hold has a 30 s backstop.
- Boot migrations with 2 replicas: `migrate.ts` takes a blocking `pg_advisory_lock` on a `max:1` handle around drizzle's whole `migrate()`; the second replica waits and then finds nothing pending. A failure exits non-zero.
- Backoff math: provider reset preferred; jitter only lengthens; cap respected.

## Steps
1. 02.14: give the scheduler locks their own pool, stagger first ticks, add the boot guard (`advisory-lock.ts`, `scheduler/fromEnv.ts`, `runner.ts`, `config/env.ts`).
2. 02.1 + 02.3 together, since they touch the same files (`breaker.ts`, `health.ts`, `snapshot.ts`, `recheck.ts`, `connect/claude.ts`, `oauth-exchange.ts` wiring): `blockedAt` plus a half-open reset.
3. 02.15 half-open failure always re-trips (`breaker.ts`).
4. 02.4 + 02.17: a refused probe gets 429 and a usage row; generic zero-attempt guard in `orchestrator.ts`.
5. 02.7: Kimi coding-id prices (ops override rows now).
6. 02.2: refresher lock + CAS (`refresher.ts`, `exchange.ts`, `status.ts`). Prod is single-replica, so this can follow the rest.
7. 02.5: catalog/price-book generation refresh.
8. 02.6: rollup request attribution + backfill note.
9. 02.8, 02.10: quota staleness + guarded upsert.
10. 02.11, 02.12, 02.13, 02.16, 02.18.

No migration needed. 02.14 option (a) and 02.7's per-account price alias would each need one; if taken, they become this slice's `0025`.

## Tests
- `bun test apps/api/src/services/routing apps/api/src/services/dataplane/health.test.ts apps/api/src/services/dataplane/snapshot.test.ts apps/api/src/services/dataplane/chain.test.ts apps/api/src/services/accounts apps/api/src/services/catalog apps/api/src/services/cost apps/api/src/services/usage-read apps/api/src/scheduler packages/db/test`
- `bunx biome check apps/api/src/services/{routing,catalog,cost,accounts,dataplane,usage-read} apps/api/src/scheduler packages/db/src`
- `bun run typecheck`

## Done when
- 9 tasks due at once never deadlock or starve a pool with `DB_POOL_MAX` at or below the task count (or boot refuses that configuration).
- Reconnect (OAuth and Claude) and Re-check clear a blocked verdict on every replica within one catalog refresh, and Re-check yields exactly one probe.
- A failed half-open probe always re-opens the breaker.
- Probe-race losers get `429` + `Retry-After` and a `UsageRecord`; every dispatch writes at least 1 row once a model is named.
- Each Kimi upstream id observed in prod prices non-`unknown`.
- Two replicas never present the same refresh token, and a lost refresh race never writes `needs_reauth`.
- An admin write is visible to the next request (no stale coalesced load).
- Closed-day `requests` equals the raw distinct correlation ids for the same day.
- No spent window without a reset blocks an account past the staleness bound.

## Falsified doc claims
- `CLAUDE.md` says "11 migrations"; `packages/db/migrations/` holds 0000–0024 (25).
- `docs/idea/01-architecture.md:329` "Never N parallel refreshes racing to write the same row" vs `refresher.ts:244-253`, which single-flights per process only.
- `docs/idea/01-architecture.md:240` / `catalog/store.ts:23` "after an admin write … read-after-write consistent" vs `store.ts:60-71`, which can coalesce onto a load issued before the write.
- `docs/idea/05-routing-and-failover.md:506` and `recheck.ts:13-23` "Re-check… next request becomes the probe, the ones behind it wait" vs `health.ts:315`: `reset` leaves the account `FRESH`/active with no gate.
- `routing/breaker.ts:8` "half-open… Failure → cooling_down at the next backoff step" vs `breaker.ts:172-178` (02.15).
- `routing/failover.ts:12,61` says 401/403 parks the account `disabled`. That is stale: `breaker.ts:146-155` lands api-key auth on a `credential-rejected` cooldown.
- `scheduler/tasks/quota-floor.ts:30-34` "cost of that mistake is one write that removes an already-expired number" vs 02.10, where it can remove a fresh one.
- `advisory-lock.ts:93-99` presents the reserved connection as costless; `docs/idea/09-deployment.md:112` warns that a long sweep holds a connection but never says lowering `DB_POOL_MAX` below the task count can deadlock (02.14).
- `providers/drivers/kimi.ts:11` says `kimi` uses its own ids (`k3`), but `cost/prices.ts` prices `kimi` off the platform table (02.7).
- No SQLite / `DATABASE_PATH` mentions in `docs/idea/`. The "single-file compromise" at `09-deployment.md:364` is about backups, so it is fine.

## Not covered
- `services/models/**`, `services/pools/service.ts` validation, `config-dir-reap.ts`, `sdk-transcript-sweep.ts`, `model-catalog-refresh.ts`, `oauth-purge.ts`, `admin-session-purge.ts`: skimmed or not read.
- Policies `least-used.ts`, `quota-aware.ts`, `sticky.ts`, `priority-failover.ts`, `round-robin.ts`: not audited line by line. `weighted.ts`, `order.ts`, `index.ts`, `hash.ts` and `backoff.ts` were.
- `usage-read` raw queries (`series`, `latency`, `outcomes`) scan raw rows over the whole window, so 30d/lifetime silently cover only the raw retention. Not verified against the UI's labels.
- No local-timezone windows exist (UTC only). Whether operators expect local "today" is a product question, not a bug.
- Prod verification still needed: the Kimi `upstream_model` values (02.7); `/readyz` behaviour under pool starvation (02.14).
- Cross-area: `IDLE_PROBE_MODELS.kimi = "k2"` (`idle-account-probe.ts:93`). The coding surface's ids are `k3`/`k2*` per `kimi.ts`, so it may be valid. Slice 03 should confirm. Session-binding cache misses query Postgres on the request path (`session-binding.ts:43`); slice 01 owns that path and is affected by 02.14.
