# 03 — Routing, health, account lifecycle

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/routing/`, `apps/api/src/services/health/`, `apps/api/src/services/recovery/`, `apps/api/src/services/snapshots/`, `apps/api/src/services/accounts/`.

## Findings

### 03.1 high — "Re-check now" / "Re-check all" gates a healthy account behind a one-probe permit
- **Kind:** nn-violation (router-made `429` with an eligible account in scope; bookkeeping holding a healthy account out of rotation). Verified by reading, not by a run.
- **Where:** `apps/api/src/services/accounts/recheck.ts:107-128,166-174`; `packages/db/src/repositories/account-recovery-begin.ts:46-73`; `apps/api/src/services/routing/filter.ts:113-120`; `apps/api/src/services/routing/recovery-filter.ts:8-11`; settle point `apps/api/src/services/dataplane/chain-relay.ts:130-137`.
- **Defect:** `beginOperatorRecovery` publishes a `pending` generation for every account that is not `disabled`/`exhausted`/`needs_reauth`/logged-out, including one that is `active`, breaker closed, no spent window. `recoveryIsGated` then drops it as `probe-in-flight` for every request but the single permit holder, until that holder's stream ends.
- **Failure scenario:** 5 healthy Claude subs serving agents. Operator presses Overview "Re-check all" (`routes/admin/accounts.ts:93`). All 5 go `pending` (lifecycleVersion and healthRecoveryVersion bumped, so pre-start attempts also get `UpstreamAdmissionRefused`). Each admits one request; that request's turn runs minutes; the permit settles only at relay terminal. Every other bound session is `blocked: probe-in-flight`, waits `RECOVERY_REQUEST_WAIT_MS` (5 s), then `429`. With no traffic the router's own probe spends one billed turn per subscription. Same shape as the 2026-10-06 reconnect incident already fixed by `publishAccountRecovery(settled: true)` (`account-recovery-generation.ts:61-90`).
- **Fix:** a re-check of an account nothing holds out must publish a settled generation, not a probe. (a) `recheck.ts`: inject `isLiveHealthy(accountId)` (overlaid status `active`, no running `cooldownUntil`, no spent window, recovery absent or `succeeded`/`cancelled`) and pass `settled: true` through `finalizeOperatorCheck` → `beginOperatorRecovery`; (b) `account-recovery-begin.ts:57-72`: forward `settled` to `replaceGeneration` (db slice owns the file). Keep the probe gate for anything blocked or cooling. Update `docs/idea/05-routing-and-failover.md` (re-check section) and `CHANGELOG.md`.
- **Test:** integration (mocked upstream): healthy account, `POST /api/admin/accounts/recheck`, then 3 concurrent requests → all `200`, three `UsageRecord` rows, no `probe-in-flight` rejection. Unit: `recheck-recovery.test.ts:105-121` currently asserts `state: "pending"` for a default `active` row — update to the settled state, keep the pending assertion for a cooling/blocked row.

### 03.2 medium — Rotation counter advances for every pool in the key's scope, on failed selections and on every re-select
- **Kind:** bug (fairness). Fix lives in the dataplane slice.
- **Where:** `apps/api/src/services/dataplane/orchestrator.ts:248-251`; `apps/api/src/services/dataplane/rotation.ts:41-49`.
- **Defect:** `rotation.advance(group.poolId)` runs for all `decision.groups`, not the group that placed the head; it also runs when `selection.ok === false` and once per loop of `selectThroughRecovery` / chain retry. The unpooled counter (`null`) is shared by every `all`/`accounts`-scoped key.
- **Failure scenario:** key K1 scoped to pools `[A, B]`, key K2 scoped to `[B]`, B is `round-robin` with 2 accounts. Traffic alternates K1, K2. A serves K1 but B's counter still moves, so K2 reads 1, 3, 5 … → always the same B account. Exactly the stride `rotation.ts:11-13` says cannot happen. A request waiting 5 s on a recovery hold advances the counter ~20 times.
- **Fix:** advance only `selection.ok && binding.state !== "honored"`, and only the group that contributed `candidates[0]` (`candidates[0].poolId`). Advance once per request, not per re-select (hoist a `placed` flag outside `select`). Update `docs/idea/05-routing-and-failover.md:388-395`.
- **Test:** unit `test/unit/dataplane/rotation.test.ts` + a dispatcher-level case: two keys, overlapping pools, assert K2's placements alternate; failed selection leaves counters unchanged.

### 03.3 medium — Every request rebuilds the whole fleet's snapshot, whatever the key's scope
- **Kind:** perf (measured)
- **Where:** `apps/api/src/services/dataplane/snapshot.ts:97-118`; `apps/api/src/services/dataplane/recovery-access.ts:71-95`; `apps/api/src/services/routing/scope.ts:38,82`; call site `orchestrator.ts:236-253`.
- **Defect:** per request (and per re-select): `recovery.catalog.accounts()` maps all accounts (spread + `new Date` per recovery row), `buildSnapshot` reconciles and `overlayHealth`s all accounts (`mergeQuotaWindows` builds a Map + array each), `pools.map` spreads every pool, `resolveScope` builds a Map of all accounts and all pools.
- **Failure scenario:** scratch bench (overlay + `selectAccounts`, 3 quota windows per account, `sticky`): 5 accounts 25 µs, 20 → 97 µs, 50 → 258 µs, 200 → 852 µs per select. A key scoped to 2 accounts still pays 127 µs at 50 accounts and 294 µs at 200. Synchronous event-loop time; the recovery-catalog pass is not included. Pooling many accounts is the normal case.
- **Fix:** (1) memoize the overlay per account on `(catalog account object, health state object, capability availability)` identity — health states are replaced, never mutated (`health.ts:139-141`), so only accounts touched since the last request recompute; (2) build the id → account Map and pool Map once per catalog install, not per request (`catalog/store.ts:63-67` install hook); (3) overlay lazily for in-scope ids only (`resolveScope` first, overlay second); (4) run `health.reconcile` on catalog install only — it already runs there (`composition/warm-state.ts:93-98`), the per-request loop at `snapshot.ts:104-106` is redundant if so (verify before deleting). Routing stays pure: the snapshot is still injected.
- **Test:** unit: memoized overlay returns the same object until the health state or catalog row changes; changed `inFlight` invalidates only that account. Add a 50-account case to `bin/bench` and record p99 before/after.

### 03.4 medium — `recheckAll` is serial with a full catalog reload and a CLI subprocess per account
- **Kind:** perf / db
- **Where:** `apps/api/src/services/accounts/recheck.ts:127,166-174`.
- **Defect:** for each account in turn: `reserveOperatorCheck` tx, `claude auth status` subprocess (subscription accounts), `finalizeOperatorCheck` tx, `refreshCatalog()` (five-table repeatable-read load of the whole world), audit insert, `releaseOperatorCheck`.
- **Failure scenario:** 30 accounts → 30 full catalog loads + ~120 statements + up to 30 sequential subprocesses inside one admin HTTP request; the console button spins for tens of seconds and each reload re-allocates every `RoutableAccount` (which also defeats 03.3's memo while it runs).
- **Fix:** split `attempt` into commit and publish phases; `recheckAll` runs commits with bounded concurrency (config, e.g. reuse the SDK probe ceiling), then one `refreshCatalog()`, then `onRecoveryRequested` per pending id. Skip accounts 03.1 classifies live-healthy. Single `recheck` keeps its own refresh.
- **Test:** unit `recheck.test.ts`: 10 accounts → `refreshCatalog` called once; a pending generation is still installed before `onRecoveryRequested` fires.

### 03.5 low — `quota-aware` breaks headroom ties by declared order, never by rotation
- **Kind:** bug (hot-spot)
- **Where:** `apps/api/src/services/routing/policies/quota-aware.ts:38-41`.
- **Defect:** ranked candidates with equal headroom sort by `compareDeclared`; `rotationCounter` is applied to unranked accounts only.
- **Failure scenario:** 6 fresh subscriptions all reading 0% (or any coarse/equal reading): every unbound session lands on the first declared account until its gauge moves; a burst of 20 agents all start on one sub. `CHANGELOG.md:1466` says quota-aware's tiebreak rotates.
- **Fix:** bucket ranked candidates by headroom (exact equality, or a small config epsilon) and `rotate` within each bucket by `rotationCounter`. `least-used` has the same shape between selection and `beginAttempt` (`unverified`: depends on awaits between `select()` and `health.beginAttempt`).
- **Test:** unit `policies.test.ts`: 3 candidates at equal headroom, counters 0..5 → head cycles through all three.

### 03.6 low — `sticky` recomputes two hashes per comparison
- **Kind:** perf
- **Where:** `apps/api/src/services/routing/policies/sticky.ts:22-25`; same in `hash.ts` `rendezvousRank`.
- **Defect:** `scoreWithSeed` (two FNV passes over a 36-char id + two fmix) runs for both sides of every comparator call: O(n log n) × 4 hash passes instead of n × 2.
- **Failure scenario:** 50 candidates ≈ 280 comparisons ≈ 1,100 FNV passes per request vs 100.
- **Fix:** score once into a parallel array, sort indices (decorate-sort-undecorate). Scores unchanged, so `hash.test.ts` vectors hold.
- **Test:** existing `sticky-affinity.test.ts` / `hash.test.ts` must pass unchanged; add an order-equality property test against the current comparator.

### 03.7 low — A thrown exhausted re-test still advances the doubling clock
- **Kind:** bug (gate exit delayed). File is in the scheduler slice; the rule is rule 7's.
- **Where:** `apps/api/src/scheduler/tasks/exhausted-retest.ts:64,82-87`.
- **Defect:** the watch is stored with `retests + 1` and the doubled `dueAt` before `ports.recheck` runs; `refused` restores `prior` (line 76), a throw does not.
- **Failure scenario:** account `exhausted` 24 h+, wait at the cap. The recheck's DB call fails once at the due tick → no probe sent, next look in another 24 h. Prior decision: `test/unit/scheduler/exhausted-retest.test.ts:164` ("a failed re-test is logged and the clock still advances") encodes this; it contradicts the module's own cost model ("one failed probe per `maxMs`") because no probe happened.
- **Fix:** on throw restore `prior` like `refused`; keep the error line. Update that test, do not delete it.
- **Test:** unit: recheck throws at due tick → next tick retries; `retests` unchanged.

### 03.8 low — Router-initiated probes spend the operator's "Test now" cooldown
- **Kind:** bug
- **Where:** `apps/api/src/services/accounts/test-now.ts:201-214`.
- **Defect:** `lastChecked.set(accountId, now)` runs for recovery and idle-probe callers too; only the *check* is skipped for `input.recovery`.
- **Failure scenario:** router recovery probe fires; operator presses Test now within `ACCOUNT_TEST_NOW_COOLDOWN_SECONDS` (120) → `tested: false`, though the operator pressed nothing. `test-now.ts:25-27` promises the button its own cooldown.
- **Fix:** stamp `lastChecked` only when `input.recovery === undefined && backgroundExpectedAccount === undefined`. `TestNowService.lastCheckedAt` (`:154`) has no caller in `src` — delete it or keep a separate background stamp if `background-sdk-preparation.test.ts:171` needs one.
- **Test:** unit `test-now.test.ts`: recovery-triggered test, then operator test inside the window → `tested: true`.

### 03.9 low — Per-account Maps never pruned on account or pool delete
- **Kind:** memory
- **Where:** `accounts/test-now.ts:142`; `accounts/credential.ts:82,84`; `dataplane/rotation.ts:41` (pool ids).
- **Defect:** entries outlive the account/pool. Bounded by ids ever seen in the process, so small.
- **Failure scenario:** long-lived replica with account churn (connect, delete, reconnect under new ids) keeps a `CredentialMetadata` + observation (ciphertext string) per dead id.
- **Fix:** expose `forget(id)` on each and call from the existing deletion barrier (`composition/warm-state.ts:84-98` already prunes health, SDK quota, status writer); or prune against the catalog on install.
- **Test:** unit: delete → map size returns to baseline.

### 03.10 low — `/readyz` database probe timeout is a code constant; timed-out query is not cancelled
- **Kind:** nn-violation (rule 11), minor
- **Where:** `apps/api/src/services/health/databaseProbe.ts:12,40-48`; `apps/api/src/main.ts:79`.
- **Defect:** `DEFAULT_TIMEOUT_MS = 2_000` is never overridden from env; on timeout the `select 1` stays queued on the pool.
- **Failure scenario:** wedged database + a 1 s orchestrator poll → one more queued statement per poll on the pool requests share.
- **Fix:** add the timeout to the env schema and pass it at `main.ts:79`; call `.cancel()` on the postgres.js query when the deadline wins. Also `health/claudeCliProbe.ts:36-45` does `statSync` on every unauthenticated poll — cache the resolution for a short configured TTL.
- **Test:** unit: probe times out → query's `cancel` called once.

### 03.11 low — Recovery coordinator tick: head-of-line abort and per-row account reads
- **Kind:** bug (`unverified` that a repository call can fail persistently for one row) / db
- **Where:** `apps/api/src/services/recovery/coordinator.ts:122-136,153-156,168-183`.
- **Defect:** a throw from `beginAutomaticRecovery` or `writeOutcome` aborts the whole tick; the same entry is first in the next batch, so outcomes, expiry marking and permit exposure behind it never run. Separately, `accounts.findById` runs once per issued and per pending row.
- **Failure scenario:** one poisoned queue entry → no permit is exposed on this replica until restart; every gated account stays `probe-in-flight`.
- **Fix:** per-entry try/catch with a warn and a bounded retry count before dropping the entry; batch the account reads with `findByIds` (already on `AccountRepository`, used at `accounts/credential.ts:168`).
- **Test:** unit `recovery/coordinator.test.ts`: first automatic request rejects forever → second request's permit is still exposed.

### 03.12 low — Files over 300 LOC and stale comments
- **Kind:** structure / docs
- **Where:** `routing/failover.ts` (389), `routing/no-candidates.ts` (310); comments at `routing/breaker.ts:9,193-197`, `routing/failover.ts:71-72`, `health/readiness.ts:49-50`.
- **Defect:** `breaker.ts:193-197` says a success returns `exhausted` to `active`; the store refuses it (`dataplane/health.ts:173-180`) and the exit is the `healthRecoveryVersion` bump. `breaker.ts:9` says the breaker "never schedules a retry … only an operator", predating the bounded re-test. `failover.ts:72` says a key is parked `disabled`; it cools `credential-rejected`. `readiness.ts:49` lists "cooling down" under `blocked`; `accountProbe.ts:34` counts it available.
- **Fix:** split `failover.ts` (overload wait + progress folding out of the planner) and `no-candidates.ts` (message wording out of the classifier); correct the four comments.
- **Test:** none beyond existing suites.

## Checked, not a bug
- Selection is pure: no `Date.now`, `Math.random`, store or I/O anywhere under `services/routing/` (grep + read); jitter and clock are injected (`dataplane/health.ts:115,134-138`).
- Scope is an intersection and never widens: overflow must be a pool membership (`scope.ts:154-168`), binding outside scope is invalidated (`binding.ts:49-57`), empty scope → `ScopeViolationError` 403 (`no-candidates.ts:79-84`).
- `exhausted` carries no reset, is dropped before any clock check (`filter.ts:70`), and a limiter header cannot convert it to a cooldown (`dataplane/health-reading.ts:58`). Its bounded exit exists (`routing/exhausted-retest.ts`, `scheduler/tasks/exhausted-retest.ts`).
- `select.ts:140` `boundOverflow` with no overflow and no binding compares `undefined === undefined`, but the `group.overflow === null` clause returns first. Correct.
- A spent window with no `resetsAt` has exits: `cooldownRecheckDue` (`routing/cooldown-recheck.ts:28-31`) and the `quota-stale` hint (`dataplane/recovery-hints.ts:24-32`). Prior 02.8 is fixed.
- Health store entries are pruned when an account leaves the catalog (`composition/warm-state.ts:93-98`, `composition/index.ts:66`); recovery queues and `offered` are capped or forgotten (`recovery/queues.ts:15-19,25,60`, `coordinator.ts:231-234`).
- Credential refresh: expiry-driven timers, per-account flight map plus advisory lock, unreachable retries bounded by `maxAttempts`, refusal parks with one refresh per credential fingerprint (`refresh/refresher.ts:171-205`, `refresh/settle.ts:90-111`, `refresh/identity.ts:23-31`). Claude subscriptions are excluded by `httpDriver(...).oauth` (`identity.ts:25`).
- `snapshots/refresh.ts`: a mutation during a read prevents installing the stale read and forces a trailing one. Prior 03.4 / 02.5 are fixed.
- `backoffMs` / `retestWait` overflow to `Infinity` and are clamped by `Math.min`. No NaN path.
- Device-flow `tracks`/`latest` are pruned by attempt expiry (`connect/oauth-device.ts:96-99`); pending Claude logins carry a TTL timer (`connect/claude-pending.ts:61`).
- Per-attempt credential decrypt (`dataplane/egress/credential.ts:50`) is uncached AES-GCM on a short string: microseconds, and plaintext is not retained. Left as is.

## Doc claims falsified
- `docs/idea/05-routing-and-failover.md:390-391` says the rotation counter is "keyed by pool so another pool's traffic never strides this one's rotation, and advanced only when the policy placed something"; `dataplane/orchestrator.ts:248-251` advances every pool in the key's scope, including on failed selections (03.2).
- `CHANGELOG.md:1466` says `quota-aware`'s tiebreak rotates; `routing/policies/quota-aware.ts:38-41` rotates only unranked accounts (03.5).
- `apps/api/src/services/dataplane/rotation.ts:11-13` (same claim as the first bullet).
- Comment-level drift listed in 03.12.

## Steps
1. 03.1: `settled` path for live-healthy accounts in `recheck.ts` + `account-recovery-begin.ts`; tests; doc + changelog.
2. 03.2: single advance for the placing pool, once per request; rotation tests; doc fix.
3. 03.3 + 03.6: overlay memo, install-time maps, lazy in-scope overlay, sticky decorate-sort; bench before/after.
4. 03.4: `recheckAll` batching, one catalog refresh.
5. 03.5: tie rotation in `quota-aware`.
6. 03.7, 03.8, 03.9: small state fixes with their tests.
7. 03.10, 03.11: probe timeout config + cancel; coordinator per-entry isolation.
8. 03.12: file splits and comment corrections last, no behavior change.

## Tests
- Extend: `apps/api/test/unit/accounts/recheck-recovery.test.ts`, `recheck.test.ts`, `test-now.test.ts`; `apps/api/test/unit/dataplane/rotation.test.ts`; `apps/api/test/unit/routing/policies.test.ts`, `sticky-affinity.test.ts`; `apps/api/test/unit/scheduler/exhausted-retest.test.ts`; `apps/api/test/unit/recovery/coordinator.test.ts`.
- Add: integration case for re-check on a healthy account (three `UsageRecord` rows, no `429`); unit for the overlay memo.
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end. `bin/bench` for step 3 only.

## Done when
- Re-check of a live-healthy account never produces a `probe-in-flight` rejection; blocked accounts still get exactly one probe.
- Two keys over overlapping pools both rotate evenly; a failed selection moves no counter.
- Select cost at 50 accounts drops by at least half in the scratch bench and a 2-account key no longer scales with fleet size.
- `recheckAll` performs one catalog refresh.
- Equal-headroom `quota-aware` candidates rotate.
- A thrown exhausted re-test retries on the next tick.

## Not covered
- Read only in part: `accounts/connect/claude.ts`, `oauth.ts`, `oauth-exchange.ts`, `oauth-binding.ts`, `oauth-paste.ts`, `issuer-request.ts`, `claude-subject.ts`, `claude-lifetime.ts`, `connect/fromEnv.ts`, `connect/service.ts`; `accounts/discover-models.ts`, `providers.ts`, `view.ts`, `login-lifetime.ts`, `last-login.ts`, `oauth-response.ts`, `recovery-view.ts`.
- Not read: `dataplane/recovery-probe.ts`, `recovery-capability.ts`, `status-writer.ts`, `quota-writer.ts`, `scheduler/tasks/cooldown-recheck.ts`, most of `packages/db` recovery repositories (only `account-recovery-begin.ts` and part of `account-recovery-generation.ts`).
- 03.1 is established from the code path, not from a running router; no integration test was run. The bench in 03.3 is a scratch micro-benchmark, not `bin/bench`.
- Tests were inventoried and spot-read, not read in full.
- Key-scope id lists are not de-duplicated at the schema (`services/keys/schemas.ts:28`); whether storage de-duplicates them was not checked. A duplicated pool id would double-advance its counter under 03.2.
