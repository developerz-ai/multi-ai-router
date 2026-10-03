# 10 — Database

> Part of [overview.md](overview.md). Depends on: none; supplies interfaces needed by 02, 03, 07, 09. Owns: `packages/db/` including every schema change/migration and DB tests. This is the only slice allowed to add migrations.

## Findings

### 10.1 high — Daily rollups permanently omit pre-selection failures
- **Where:** `packages/db/src/repositories/usage-daily-repository.ts:232`; `packages/db/src/schema/usage-daily.ts:35`.
- **Defect:** rollup filters out NULL account/key IDs and its schema requires both, excluding valid usage failures that never selected an account.
- **Failure scenario:** October 1 production has 31 distinct raw requests/31 attempts, 8 with no account; daily table has 23 requests/attempts. September 30 has 10 raw, 8 without account, only 2 rolled. A closed-day dashboard silently loses those failures; raw retention later makes them unrecoverable.
- **Fix:** represent absent/deleted dimensions in rollups; preserve all valid attempt outcomes. Use a NULL-safe unique grain and migrate/backfill only complete retained days, without overwriting older preserved history from incomplete raw data.
- **Test:** no-candidate 429 and normal success on same day survive rollup, rerun, raw retention and summary reading with exact request/error totals.

### 10.2 high — Summed per-account distinct counts double-count failover requests
- **Where:** `packages/db/src/repositories/usage-daily-repository.ts:219`, `:234`, `:136`.
- **Defect:** distinct requests are counted inside account/model/pool groups, then summed as though distinct across those groups.
- **Failure scenario:** one correlation tries A then succeeds on B → two rollup rows each requests=1 → global/key/pool summary says 2 requests, whereas raw count(distinct correlation_id)=1. Attempts should remain 2. This is independent of NULL-row omission.
- **Fix:** preserve a request-level aggregate grain or separate request totals from per-attempt attribution. Define and test which dimensions own a request; global and per-key totals cannot sum account-specific distinct counts. Keep attempts additive.
- **Test:** two-account failover has requests=1, attempts=2 before and after day closure; include pool/model transitions and repeat rollup.

### 10.3 high — Pool deletion creates duplicate historical rollup groups
- **Where:** `packages/db/src/schema/usage-records.ts:64`; `packages/db/src/repositories/usage-daily-repository.ts:235`.
- **Defect:** raw pool_id is ON DELETE SET NULL, while an already-written daily pool group persists; reroll inserts the new NULL-pool group without removing the old group.
- **Failure scenario:** request in pool P, roll up today, delete P, roll up today again → old P row and new NULL row both count the same attempt/cost.
- **Fix:** preserve immutable event dimensions or atomically replace the complete set of groups for fully retained days, with explicit handling for deleted dimensions. Do not blanket-delete historic rolled days for which raw data is incomplete.
- **Test:** rollup → pool deletion → reroll keeps global requests/attempts/tokens/cost unchanged; attribution retains a documented deleted/none distinction.

### 10.4 medium — Retried acknowledged-lost inserts duplicate usage
- **Where:** `packages/db/src/repositories/usage-repository.ts:82`; `packages/db/src/schema/usage-records.ts:39`; caller `services/usage/recorder.ts:126` (07).
- **Defect:** insertMany has no stable idempotency key while the recorder retries every rejected write once.
- **Failure scenario:** Postgres commits an insert, then connection drops before client receives success; recorder retries the same batch, defaultRandom generates new IDs, and both copies remain. Attempts/tokens/cost double even though one request ran. This is a fault scenario, not observed duplicate rows in current evidence.
- **Fix:** assign stable row IDs before first enqueue or enforce a documented unique attempt identity, then use conflict-safe retry. Include intentional session restart/failover attempt numbering in key design.
- **Test:** writer commits then simulates lost acknowledgement; retry leaves one row per logical attempt and exact cost.

## Steps
1. Design one coordinated migration for NULL dimensions/request aggregate grain/attempt identity as needed; audit old data before backfill.
2. Land SQL failure-first tests for all four defects; preserve complete-history behavior.
3. Add bounded lock-connection support and compare-and-clear quota API required by 09; transactional key scope/membership APIs required by 02/03. These implement findings counted in their owner slices, not additional findings here.
4. Update `docs/idea/02-domain-model.md` and `docs/idea/08-observability.md` via coordinator.

## Tests
Use disposable local Postgres, `bin/test ./packages/db/test/integration` plus affected HTTP integration tests. Never point tests/migrations/backfills at production during this audit. Coordinator runs `bin/check` once with that disposable DATABASE_URL.

## Done when
Counts/cost survive failover, failed routing, deleted dimensions, retry and retention without omission or multiplication; migration/backfill has a bounded reviewed strategy.

## Falsified claims / not covered
Daily schema says aggregates survive deleted subjects; pool deletion plus reroll can multiply them. Source says requests are distinct from attempts; grouped distinct sums violate this. Live DB had 25 migrations, 126 MB, approximately 308k raw rows, no stale unfinished tasks, and an active successful backup stream. No production writes, destructive repair, recovery drill, fault injection, or exhaustive index/load analysis performed.
