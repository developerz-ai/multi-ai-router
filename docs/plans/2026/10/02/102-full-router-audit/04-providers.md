# 04 — Providers

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/providers/` excluding `claude-sdk/`, and `apps/api/test/unit/providers/` excluding SDK-specific tests. Documentation edits coordinated through the overview.

## Findings

### 04.1 medium — Provider duration resets never reach the cooldown decision
- **Where:** `apps/api/src/providers/rate-limit/parse.ts:149`; duration retained only at `:99`. Consumer: `apps/api/src/services/dataplane/health-reading.ts:58`, `apps/api/src/services/routing/backoff.ts:30`.
- **Defect:** Aggregate `RateLimitSignal` ignores `windows[].resetAfterSeconds`, despite successfully parsing the provider's duration.
- **Failure scenario:** HTTP 429 with `x-ratelimit-remaining-requests: 0`, `x-ratelimit-reset-requests: 6m`, no `Retry-After` → window reports 360 seconds, aggregate reports `resetSource: "unknown"` with neither reset field. The existing cooldown consumer reads only aggregate fields and falls back to exponential retry instead of the stated six-minute delay.
- **Proof:** Pure parser invocation produced `{ limited: true, resetSource: "unknown", windows: [{ limiter: "requests", remaining: 0, resetAfterSeconds: 360, resetSource: "provider-reported" }] }`.
- **Fix:** Derive aggregate relative delay from the relevant depleted limiter(s) when explicit retry information is absent. Keep the parser clock-free. Prefer explicit `Retry-After`; do not substitute the reset of an unrelated, non-depleted limiter. Preserve every window's reading and provenance. If multiple independent depleted windows must recover, use the delay that permits all of them to serve again; leave genuinely unidentified limits unknown.
- **Test:** Failure first in `apps/api/test/unit/providers/rate-limit.test.ts`: the exact six-minute headers produce aggregate 360 seconds and provider-reported provenance. Cover multiple depleted windows, a non-depleted short window, explicit retry precedence, bare 429, and quiet 200. Through the existing health-store test seam, assert the resulting cooldown rather than merely the parsed window.

## Cross-slice support
- OAuth ID-token-only identity loss is owned by **03 — Routing / account services**, not counted twice here. Provider support touches `providers/types.ts:66` and `providers/drivers/openai-oauth.ts:201`: carry validated provider identity from encrypted OAuth metadata into header construction; preserve the access-token fallback for older credentials. Connect/refresh persistence and credential decoding belong to 03. Never expose ID/access/refresh tokens or provider account identity to public errors.

## Documentation claims falsified
- `docs/idea/03-providers.md:102` promises normalized rate-limit signals; the duration is parsed but unusable by its cooldown consumer. Update reset-selection semantics alongside the fix.
- `docs/idea/03-providers.md:411` still says rejected API keys become `disabled`; current classification comments and the latest `db5c138` change explicitly use credential-rejected cooldown. Coordinator should remove this stale paragraph, without reverting the new behavior.

## Steps
1. Add the duration-reset failure case; verify it fails against the current parser.
2. Fix aggregate reset derivation without clock, network, or database access.
3. Add edge-case coverage and coordinate the OAuth contract with 03.
4. Have the coordinator update `docs/idea/03-providers.md` and the reset contract in `docs/idea/05-routing-and-failover.md` in the same PR.

## Tests
- Baseline: selected provider/translation/SDK unit suites → **1,111 pass, 0 fail**, 52 files, 2,635 assertions. Evidence: [`04-06-unit-tests.log`](04-06-unit-tests.log).
- Implementation: `bin/test apps/api/test/unit/providers/rate-limit.test.ts`, then affected health-store tests; `bunx biome check <changed files>`.
- Coordinator runs `bin/lint (includes typecheck)` and `bin/check` with `DATABASE_URL` once, plus `bin/bench` if request-path code changes.

## Done when
- A six-minute provider reset produces a six-minute cooldown with reported provenance; explicit retry information survives.
- Existing API-key auth classification and exhausted-account behavior remain intact.
- OAuth identity support agrees with 03's encrypted storage contract.

## Coverage and limits
- Reviewed provider registry, driver construction, authentication headers, base URLs, aliases, OAuth builders/reader, failure classification, rate-limit parser and associated tests/history.
- Inspected latest provider/SDK/translation history and GitHub issue search; no live provider requests or OAuth exchanges performed.
- Upstream endpoint/constant drift and every vendor's current response variants were not revalidated against live services. These are coverage limits, not confirmed defects.
