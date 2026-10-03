# 08 — Cost

> Part of [overview.md](overview.md). Depends on: 07. Owns: `apps/api/src/services/cost/` and cost tests.

## Findings

### 08.1 medium — Production Kimi model `k3` has no price lookup
- **Where:** `apps/api/src/services/cost/tables/moonshot.ts:26`; `cost/prices.ts` lookupRates; `cost/rates.ts` modelLookupKeys.
- **Defect:** the shipped Kimi table has `kimi-k3`, while production uses upstream_model `k3` and there is no lookup alias covering it.
- **Failure scenario:** all 109 Kimi successes in the 24-hour production query return cost_basis=unknown and NULL cost. No operator price overrides exist. The same production model cannot contribute to a priced total.
- **Fix:** verify the provider's current `k3`/`kimi-k3` identity and price provenance before adding a cost-only canonical alias or verified entry. Do not alter the model on the wire. Keep unknown when equivalence cannot be established; surface an actionable unpriced-model warning instead of inventing a price. Related existing [#138](https://github.com/developerz-ai/multi-ai-router/issues/138).
- **Test:** actual observed model id resolves the verified rate, or produces explicit unpriced coverage; model forwarding remains unchanged.

### 08.2 medium — Post-edit refresh may install a pre-edit price snapshot
- **Where:** `apps/api/src/services/cost/book.ts:66`.
- **Defect:** refresh unconditionally shares an in-flight load, even when a caller just committed a price edit after that load took its snapshot.
- **Failure scenario:** periodic load reads old rates and pauses; admin saves new rate and awaits refresh; it receives the old promise, which installs old rates and resolves success. Subsequent requests price using the old override until the timer runs again.
- **Fix:** support an invalidation generation or a required trailing reload after mutation. Ensure the admin's awaited refresh includes a snapshot taken after its write; preserve single flight for ordinary readers.
- **Test:** deferred old load + committed new override + awaited refresh must leave new rate in lookup before admin completion. Pure repro currently produces one load/shared promise for both calls.

## Steps
1. Reproduce each failure and verify current provider price provenance.
2. Implement lookup coverage and post-mutation freshness.
3. Update `docs/idea/08-observability.md` via coordinator.

## Tests
`bin/test ./apps/api/test/unit/cost ./apps/api/test/unit/settings/prices.test.ts`; coordinator runs one final `bin/check` with disposable Postgres.

## Done when
Observed production model has verified pricing or explicit unresolved coverage; a successful price edit affects the next request.

## Falsified claims / not covered
`book.ts:15` claims awaited refresh gives read-after-write consistency; coalescing violates it. Published vendor prices/currency changes were not independently re-priced in this audit; `k3` equivalence remains a verification step, not an asserted fact.
