# 07 — Usage

> Part of [overview.md](overview.md). Depends on: 01, 10. Owns: `apps/api/src/services/usage/`, `apps/api/src/services/usage-read/` and their tests.

## Findings

### 07.1 high — Responses cached input is charged twice
- **Where:** `apps/api/src/services/usage/tokens.ts:63`, `:137`; caller `apps/api/src/services/dataplane/chain-relay.ts:67` (01).
- **Defect:** every `input_tokens` value is interpreted as Anthropic's uncached count; Responses uses that name for the entire prompt.
- **Failure scenario:** Responses usage `{input_tokens:100,input_tokens_details:{cached_tokens:40},output_tokens:5}` → observer returns `tokensIn:100,cacheReadTokens:40`; correct uncached input is 60. Cost, quotas and charts see 140 prompt tokens instead of 100. Direct execution reproduced this. Compare existing correct protocol semantics in `services/translate/shared/usage.ts:26`.
- **Fix:** inject upstream dialect into the observer from slice 01; distinguish inclusive Responses input from exclusive Anthropic input, preserving streaming and same-dialect byte forwarding.
- **Test:** failure-first unit for all three dialects and split chunks; mocked Responses integration asserts UsageRecord 60 uncached + 40 cached and exact cost.

### 07.2 high — Untrusted usage count can discard an entire write batch
- **Where:** `apps/api/src/services/usage/tokens.ts:124`; `packages/db/src/schema/usage-records.ts:104` (10).
- **Defect:** Number.isSafeInteger permits counts beyond PostgreSQL integer's ceiling; one such value makes the batch fail twice and disappear.
- **Failure scenario:** upstream returns `prompt_tokens:2147483648`; observer accepts 2147483648. Postgres rejects the integer column; all up to USAGE_BATCH_SIZE records in the same batch are retried then discarded by `usage/recorder.ts:133`. Pure observer reproduction confirms acceptance; batch loss follows existing retry behavior/schema.
- **Fix:** validate counts against the persistence domain at the observation boundary. Reject/report malformed fields without poisoning unrelated usage. Coordinate any schema expansion with 10; do not merely increase the ceiling to another unbounded value.
- **Test:** bad usage adjacent to valid usage; valid row persists, malformed count is flagged; include exponent/fraction/negative encodings so the regex cannot silently turn malformed values into plausible integers.

### 07.3 medium — Caller UUID merges unrelated client requests
- **Where:** `apps/api/src/services/usage/record.ts:111`, `:122`; `middleware/requestId.ts:18` (01).
- **Defect:** correlationIdFrom treats any supplied UUID as router-owned and reuses it.
- **Failure scenario:** two independent requests, or two keys, send the same UUID x-request-id → identical correlation_id; count(distinct correlation_id) reports one request and recent chains can merge. Direct calls reproduced equality.
- **Fix:** mint a new internal correlation UUID once per ingress; keep the caller's id separately even when syntactically UUID. Slice 01 passes both into orchestration. Keep response trace semantics explicitly documented.
- **Test:** repeated supplied UUID across two HTTP requests and two keys produces distinct internal IDs, preserved external IDs, and two counted requests.

### 07.4 medium — Lifetime chart contains only 1970–1971
- **Where:** `apps/api/src/services/usage-read/axis.ts:24`, `:35`; `usage-read/window.ts:81`.
- **Defect:** lifetime starts at Unix epoch; buildAxis stops after the first 400 daily buckets, dropping every modern data point during densify.
- **Failure scenario:** lifetime at 2026-10-02 → 400 buckets beginning 1970-01-01, ending 1971-02-04; nonzero totals with a zero chart despite current traffic.
- **Fix:** define bounded chart semantics around retained/available data or adaptive buckets. Never truncate the oldest prefix while silently discarding all recent observations. Move the limit into configuration. Coordinate historical series source with rollup capabilities in 10.
- **Test:** lifetime with current and historical activity contains the current bucket and preserves counts; >400-day custom windows explicitly aggregate or bound output.

## Steps
1. Add failure-first tests above; coordinate observer/internal-id arguments with 01.
2. Make token observations dialect aware and persistence-safe.
3. Separate internal IDs from supplied trace labels; fix bounded time axes.
4. Update `docs/idea/08-observability.md` and token semantics in `docs/idea/06-protocol-translation.md` through the coordinator.

## Tests
Use `bin/test ./apps/api/test/unit/usage` and the affected integration files against disposable local Postgres; `bin/lint`/`bin/check` once by coordinator. No live providers.

## Done when
Accurate cached counts; malformed upstream usage cannot lose another request; stable distinct-request identity; lifetime chart shows recent activity.

## Falsified claims / not covered
`usage/record.ts` calls the UUID router-owned, but it can originate from a client. Stream observer accounting disagrees with the repository's own Responses translation semantics. Disk-crash queue recovery and arbitrary provider response shapes were not exhaustively tested. Historical series currently use raw rows after raw retention; loss outside retention is an additional design limit, not included as a separate counted defect.
