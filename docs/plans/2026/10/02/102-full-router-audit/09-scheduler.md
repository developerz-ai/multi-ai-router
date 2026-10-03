# 09 — Scheduler

> Part of [overview.md](overview.md). Depends on: 10. Owns: `apps/api/src/scheduler/` and scheduler tests.

## Findings

### 09.1 high — Small shared pool deadlocks every scheduled task
- **Where:** `apps/api/src/scheduler/runner.ts:128`; `scheduler/lock.ts:24`; `packages/db/src/advisory-lock.ts:101` (10).
- **Defect:** the lock reserves a pool connection, but begin/work/finish use repositories on the original pool, requiring an additional connection.
- **Failure scenario:** valid DB_POOL_MAX=1; task reserves the sole connection, then awaits repo.begin forever; it cannot release until begin finishes. Readiness and other DB work queue behind it. Concurrent tasks produce the same starvation when reservations occupy a larger pool. Not observed in current production: two idle DB sessions and no stale task runs at sample time.
- **Fix:** use a separate bounded lock pool or transaction/session-bound repositories on the reserved connection; maintain session-scoped lock ownership throughout the task. Do not rely only on a larger default pool. Coordinate connection API in 10 and environment validation in 11.
- **Test:** disposable Postgres with pool max=1, runNow one task and simultaneous tasks; bounded completion, persisted finishedAt, unlocked session; verify stop can finish.

### 09.2 high — Quota-floor sweep can overwrite a fresh provider reading
- **Where:** `apps/api/src/scheduler/tasks/quota-floor.ts:87`, `:101`; `packages/db/src/repositories/account-repository.ts` upsertQuotaWindow (10).
- **Defect:** expiry is checked on an old read snapshot, then a blind upsert clears the row without verifying that it still matches that snapshot.
- **Failure scenario:** floor reads expired window; live request writes a new spent window with a future reset; floor then clears utilization/reset from its stale snapshot. A later catalog load or restart forgets the fresh restriction and can route to a spent account. Advisory task lock does not serialize request writers.
- **Fix:** repository compare-and-clear operation conditional on the observed reset/lastCheckedAt (or monotonic version). Skip rows changed since selection. Keep provider readings monotonic across floor and request writers.
- **Test:** interleave stale floor selection, fresh quota update, floor clear; fresh utilization and reset survive in DB and refreshed catalog.

## Steps
1. Land failure-first integration tests using a disposable DB; no live scheduler manipulation.
2. Fix lock connection use through 10's API; atomically expire quota windows.
3. Update `docs/idea/01-architecture.md` and `docs/idea/08-observability.md` via coordinator.

## Tests
`bin/test ./apps/api/test/unit/scheduler ./packages/db/test/integration/scheduler.test.ts`; add interleaving coverage. Coordinator runs one `bin/check` with DATABASE_URL.

## Done when
Every valid pool configuration supports bounded scheduler progress; stale sweeps cannot clear newer quota state.

## Falsified claims / not covered
Quota-floor comments claim clearing is safe across replicas, but no compare-and-set protects the selection/write interval. Production task history is healthy (all successes except one partial catalog refresh, no stale unfinished run); these are code-confirmed failure scenarios, not claims of an active production deadlock. Long outage/retention interactions and process-crash fault injection were not run.
