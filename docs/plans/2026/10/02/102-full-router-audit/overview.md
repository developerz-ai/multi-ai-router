# Full router audit — code, infrastructure and production

## Goal
Find actionable defects across every CLAUDE.md layer and cross-check against real production logs, PostgreSQL and infrastructure. Plan only under `.claude/commands/planx.md`; no application fixes, production writes, deploys, key changes or provider inference performed.

## Result and evidence
**54 findings: critical 0 · high 27 · medium 25 · low 2.** Count includes the already tracked secret incident #87; these are not all newly introduced or active production incidents. Severity is impact under the stated failure scenario. Each slice distinguishes direct reproduction, code-confirmed failure and unverified external behavior.

Start with **05.1 SDK session isolation**, **01.1–01.2 credential handling**, and **02.1–02.3 revoked/committed secrets and sessions**. Then repair state/authorization races and usage integrity. Production evidence does not establish that any real credential or conversation was stolen.

[Production evidence and queries](13-production.md): current pod 2.15.0, no restarts, healthy Postgres/archiving/backups; 24h contained **161 pre-selection quota failures**, **109 Kimi successes with unknown cost**, and clear rollup omissions (**Oct 1: 31 raw requests → 23 rolled**). Remote infrastructure main matches production; the local infrastructure checkout is stale, not proof of deployment drift.

[Large-prompt benchmark](evidence/bench-280k.json): translated p99 **11.11/10.00 ms**, exceeding 5 ms. [Small-prompt baseline](evidence/bench-1k.json) passes. The production overhead metric includes client-body delivery delay; its ~250 ms p99 cannot be described as pure router computation.

## Context
- Source audit at router commit `ad32f07` (v2.15.0); existing user changes to `.claude/commands/feature.md`, `planx.md` and other plan directories preserved. Do not fold those into an implementation without reviewing ownership.
- Bun + strict TypeScript, Hono, Zod; Drizzle over postgres.js; Claude subscriptions via Agent SDK; SolidJS + TanStack Solid Query. Local Bun 1.4.0; release/CI pins 1.4.2.
- `CLAUDE.md` non-negotiables govern all fixes: named tool allowlist, `settingSources: []`, no host tool execution, no Claude-token extraction, key-scope intersection, model preservation, temporary/permanent quota distinction, incremental streams, no new critical-path database work.
- Reference patterns: `packages/db/src/repositories/account-repository.ts:315` conditional status transitions; `apps/api/src/services/dataplane/records.ts:120` record construction; `apps/api/src/services/translate/shared/usage.ts:26` correct dialect token semantics; `apps/api/src/services/admin-auth/constantTime.ts` credential comparison.
- Read recent git history and GitHub issues. Existing #87 remains open; #138 covers price-table follow-ups; #137 tracks separate CLI refresh-lock questions. Closed fixes were not automatically re-filed.

## Plan files (execute in order)
1. [10-database.md](10-database.md) — atomic/conditional persistence interfaces, rollup migration, idempotency. Owns: `packages/db/` exclusively.
2. [11-config.md](11-config.md) — bounded numeric configuration, OIDC boot validation, release instructions. Owns: `packages/core/`, API config/boot/composition, root build/containers, `bin/`, workflows, `docs/RELEASING.md`.
3. [05-claude-sdk.md](05-claude-sdk.md) — isolate session aliases, honest failed results, SDK tool validation. Owns: `apps/api/src/providers/claude-sdk/` and SDK-specific tests.
4. [04-providers.md](04-providers.md) — relative reset propagation and credential metadata contract. Owns: other `apps/api/src/providers/` files and non-SDK provider tests.
5. [06-translation.md](06-translation.md) — parallel call grouping and streamed refusals. Owns: `apps/api/src/services/translate/` and translator tests.
6. [02-auth.md](02-auth.md) — keys, session revocation, login admission and OIDC. Owns: `services/admin-auth/`, `services/dataplane/auth/`, `services/crypto/`, `services/keys/`, `.ui-debugger-mcp.json`.
7. [03-routing.md](03-routing.md) — binding, recovery, conditional lifecycle and catalogs. Owns: API `services/routing/`, `accounts/`, `pools/`, `admin/`, `health/`, `models/`, `catalog/`.
8. [01-transport.md](01-transport.md) — HTTP credential handling, scanner/state behavior, timing, cookie adapter and stream accounting. Owns: API `routes/`, `middleware/`, `services/dataplane/` excluding `auth/`.
9. [07-usage.md](07-usage.md) — dialect accounting, safe counts, request identity and charts. Owns: API `services/usage/`, `services/usage-read/`.
10. [08-cost.md](08-cost.md) — unpriced production model and freshness barrier. Owns: API `services/cost/`.
11. [09-scheduler.md](09-scheduler.md) — lock-pool progress and conditional quota expiration. Owns: API `scheduler/`.
12. [12-web.md](12-web.md) — validated forms, login lifecycle and price editing. Owns: `apps/web/`.
13. [13-production.md](13-production.md) — infrastructure facts, before/after evidence. Owns: specified sibling infrastructure paths; no application implementation files.

API paths in the ownership list are relative to `apps/api/src/`. Slice numbers identify layers, not dependency order. Coordinate interfaces first: 10 supplies persistence primitives; provider metadata 04 → account lifecycle 03 → egress adapter 01; session/cookie changes 02 → 01; observer signature 07 → 01. Cross-references do not authorize concurrent edits to another slice's files. The executor coordinator owns shared integration fixtures, cross-layer integration tests and all `docs/idea/` edits; per-layer unit tests stay with their slices. Only 10 adds migrations.

## Ranked worklist
| # | Sev | Slice | `file:line` | Defect |
|---|---|---|---|---|
| 1 | high | [05.1](05-claude-sdk.md) | `apps/api/src/providers/claude-sdk/session/store.ts:191` | Fingerprint aliases allow one router key to resume another key's SDK session |
| 2 | high | [01.1](01-transport.md) | `apps/api/src/services/dataplane/relay-error.ts:22` | Same-dialect upstream errors can disclose upstream credentials |
| 3 | high | [01.2](01-transport.md) | `apps/api/src/services/dataplane/attempt.ts:76` | Automatic redirects forward custom upstream authentication to another origin |
| 4 | high | [02.1](02-auth.md) | `.ui-debugger-mcp.json:13` | Literal admin password remains committed |
| 5 | high | [02.2](02-auth.md) | `apps/api/src/services/dataplane/auth/verifier.ts:135` | In-flight key verification repopulates cache after revocation |
| 6 | high | [02.3](02-auth.md) | `apps/api/src/services/admin-auth/postgresSessionStore.ts:97` | A stale session slide can recreate a logged-out session |
| 7 | high | [02.8](02-auth.md) | `apps/api/src/services/keys/service.ts:167` | Key mutations can leave authorization in a partially committed state |
| 8 | high | [01.4](01-transport.md) | `apps/api/src/services/dataplane/body/scanner.ts:142` | Scanner and upstream disagree about the requested model |
| 9 | high | [01.5](01-transport.md) | `apps/api/src/services/dataplane/health.ts:258` | A concurrent successful response erases a terminal account verdict |
| 10 | high | [03.8](03-routing.md) | `apps/api/src/services/accounts/refresh/status.ts:35` | Background authentication results can overwrite a newer operator disable |
| 11 | high | [03.4](03-routing.md) | `apps/api/src/services/catalog/store.ts:61` | Post-write catalog refresh can reuse a pre-write snapshot |
| 12 | high | [05.2](05-claude-sdk.md) | `apps/api/src/providers/claude-sdk/render/stream.ts:258` | A message-start frame hides a later failed SDK result behind HTTP 200 |
| 13 | high | [03.1](03-routing.md) | `apps/api/src/services/routing/select.ts:35` | Healthy overflow binding is silently ignored when a primary recovers |
| 14 | high | [03.2](03-routing.md) | `apps/api/src/services/accounts/connect/fromEnv.ts:164` | OAuth reconnect does not clear the live authentication block |
| 15 | high | [03.3](03-routing.md) | `apps/api/src/services/accounts/connect/oauth-exchange.ts:131` | Accepted ChatGPT identity is discarded before dispatch |
| 16 | high | [03.7](03-routing.md) | `apps/api/src/services/accounts/refresh/refresher.ts:92` | OAuth refresh single-flight is only process-local |
| 17 | high | [02.4](02-auth.md) | `apps/api/src/services/admin-auth/service.ts:291` | Concurrent password attempts bypass the expensive-work throttle |
| 18 | high | [09.1](09-scheduler.md) | `apps/api/src/scheduler/runner.ts:128` | Small shared pool deadlocks every scheduled task |
| 19 | high | [09.2](09-scheduler.md) | `apps/api/src/scheduler/tasks/quota-floor.ts:87` | Quota-floor sweep can overwrite a fresh provider reading |
| 20 | high | [10.1](10-database.md) | `packages/db/src/repositories/usage-daily-repository.ts:232` | Daily rollups permanently omit pre-selection failures |
| 21 | high | [10.2](10-database.md) | `packages/db/src/repositories/usage-daily-repository.ts:219` | Summed per-account distinct counts double-count failover requests |
| 22 | high | [10.3](10-database.md) | `packages/db/src/schema/usage-records.ts:64` | Pool deletion creates duplicate historical rollup groups |
| 23 | high | [07.1](07-usage.md) | `apps/api/src/services/usage/tokens.ts:63` | Responses cached input is charged twice |
| 24 | high | [07.2](07-usage.md) | `apps/api/src/services/usage/tokens.ts:124` | Untrusted usage count can discard an entire write batch |
| 25 | high | [01.6](01-transport.md) | `apps/api/src/services/dataplane/orchestrator.ts:75` | Large translated requests exceed the overhead budget |
| 26 | high | [01.3](01-transport.md) | `apps/api/src/services/dataplane/body/scanner.ts:222` | Fallback session fingerprint is neither stable nor distinct |
| 27 | high | [06.1](06-translation.md) | `apps/api/src/services/translate/openai-responses-to-openai-chat/request.ts:151` | Parallel Responses calls become an invalid Chat Completions transcript |
| 28 | medium | [01.7](01-transport.md) | `apps/api/src/services/dataplane/attempt.ts:196` | Error-body classification buffers an unbounded response |
| 29 | medium | [01.8](01-transport.md) | `apps/api/src/middleware/adminAuth.ts:78` | Browser cookie does not slide with the session |
| 30 | medium | [01.9](01-transport.md) | `apps/api/src/services/dataplane/chain-relay.ts:74` | A failed response stream is recorded as successful usage |
| 31 | medium | [02.5](02-auth.md) | `apps/api/src/services/admin-auth/service.ts:211` | Public OIDC start creates unlimited state rows |
| 32 | medium | [02.6](02-auth.md) | `apps/api/src/services/admin-auth/oidc/flow.ts:91` | OIDC discovery/JWKS deadline is disconnected |
| 33 | medium | [02.7](02-auth.md) | `apps/api/src/services/admin-auth/oidc/idToken.ts:171` | ID-token checks omit issued-at and authorized-party validation |
| 34 | medium | [03.5](03-routing.md) | `apps/api/src/services/accounts/recheck.ts:134` | Re-check leaves persisted spent quota blocking the account |
| 35 | medium | [03.6](03-routing.md) | `apps/api/src/services/accounts/recheck.ts:134` | Re-check resets directly to active, bypassing its advertised one-probe gate |
| 36 | medium | [03.9](03-routing.md) | `apps/api/src/services/pools/service.ts:163` | Pool row and membership replacement are not one mutation |
| 37 | medium | [04.1](04-providers.md) | `apps/api/src/providers/rate-limit/parse.ts:149` | Provider duration resets never reach the cooldown decision |
| 38 | medium | [05.3](05-claude-sdk.md) | `apps/api/src/providers/claude-sdk/request.ts:113` | Native Anthropic server tools are silently converted into client tools |
| 39 | medium | [06.2](06-translation.md) | `apps/api/src/services/translate/openai-responses-to-openai-chat/stream.ts:195` | Streamed Responses refusals disappear in both target dialects |
| 40 | medium | [07.3](07-usage.md) | `apps/api/src/services/usage/record.ts:111` | Caller UUID merges unrelated client requests |
| 41 | medium | [07.4](07-usage.md) | `apps/api/src/services/usage-read/axis.ts:24` | Lifetime chart contains only 1970–1971 |
| 42 | medium | [08.1](08-cost.md) | `apps/api/src/services/cost/tables/moonshot.ts:26` | Production Kimi model `k3` has no price lookup |
| 43 | medium | [08.2](08-cost.md) | `apps/api/src/services/cost/book.ts:66` | Post-edit refresh may install a pre-edit price snapshot |
| 44 | medium | [10.4](10-database.md) | `packages/db/src/repositories/usage-repository.ts:82` | Retried acknowledged-lost inserts duplicate usage |
| 45 | medium | [11.1](11-config.md) | `apps/api/src/config/fields.ts:25` | Numeric environment values can overflow into immediate timers or infinite cache lifetimes |
| 46 | medium | [11.2](11-config.md) | `apps/api/src/config/env.ts:705` | OIDC boot validation accepts malformed URLs and scopes without `openid` |
| 47 | medium | [12.1](12-web.md) | `apps/web/src/routes/keys/KeyFormDialog.tsx:115` | An incomplete key rate limit silently removes the limit |
| 48 | medium | [12.2](12-web.md) | `apps/web/src/routes/accounts/AccountConnect.tsx:107` | A timestamp change is falsely reported as successful OAuth authorization |
| 49 | medium | [12.3](12-web.md) | `apps/web/src/routes/accounts/ReconnectSequence.tsx:53` | Stopping a reconnect sequence starts another login on its first account |
| 50 | medium | [12.4](12-web.md) | `apps/web/src/routes/settings/PriceOverridesSection.tsx:69` | Editing a price destroys the focused input on every keystroke |
| 51 | medium | [12.5](12-web.md) | `apps/web/src/routes/accounts/RoutingNumberFields.tsx:26` | Valid exponent-form numeric input is saved as a different number |
| 52 | medium | [12.6](12-web.md) | `apps/web/src/lib/api/settings.ts:133` | Equal-base overrides for tiered models are discarded |
| 53 | low | [11.3](11-config.md) | `docs/RELEASING.md:153` | Documented RC promotion cannot pass the release version guard |
| 54 | low | [13.1](13-production.md) | `../infrastructure/stacks/apps/multi-ai-router/README.md:29` | Infrastructure runbook describes removed session limitation |

## Causal chains / cross-slice
- **Session isolation:** 01.3 unstable/empty HTTP fingerprints + 05.1 account-only SDK aliases create different failure modes. Fixing HTTP identity alone does not isolate SDK fallback; 03.1 also permits an honored overflow binding to choose a different account.
- **Authority after mutations:** 02.2 pending key loads + 02.8 partial writes + 03.4 stale catalog refresh + 03.9 partial pool changes can keep removed authority live. Shared transactional repositories and generation barriers solve different boundaries; both are necessary.
- **Credential recovery:** 03.3 drops validated provider metadata; 03.2 fails to refresh/reset live auth; 01.5 and 03.8 allow older results to overwrite newer verdicts. A successful reconnect must establish a new generation end to end.
- **Quota:** 04.1 drops relative reset information; 03.5 prevents a deliberate recheck through durable spent windows while 03.6 can admit too many requests when no durable window exists; 09.2 can erase a newer reading. Do not solve any of these by conflating exhausted with cooling_down.
- **Reported success vs failed stream:** 05.2 can mask SDK failure; independently 01.9 records thrown stream errors as success. Fix rendering and accounting together, without retry after emitted bytes.
- **Accounting:** 07.1 token double-count and 07.2 integer poisoning precede 10.1 omitted failures / 10.2 failover double-count / 10.3 mutable dimensions / 10.4 duplicate retries. 08.1 explains the observed missing Kimi cost; 12.6 can silently change long-context pricing.
- **UI feedback:** 12.2 false OAuth completion can claim recovery before 03.2 actually restores service. Bind UI status to the real attempt, then verify its next routed request.
- **Performance:** local large-translation breach is reproduced; production metric also charges upload wait. Benchmark has in-memory dependencies, so does not prove production session/database behavior meets budget.

## Validation performed
- Four focused existing unit-suite runs: 1,013 API/auth/routing, 1,111 providers/SDK/translation, 747 config/core/web, 426 usage/cost/scheduler/DB-unit test executions; all passed. Counts are suite executions, not a claim of complete coverage. The 747 and 1,111 combined runs are each counted once despite appearing in multiple slices.
- Additional local reproductions prove missing cases: synthetic credential handling, deferred async races, SDK session alias isolation, signed test-token validation, Solid UI behavior, token observer and chart output. No real provider or Claude subprocess used.
- Two four-scenario benchmarks, 1,000 measured requests/scenario plus warmup: 1 KB baseline passes; 280 KB translation budget fails. Full JSON and delayed-body evidence retained.
- Production: bounded read-only aggregate SQL, current container log counts, pod/Argo version, resources, scheduler history, CNPG backup/archiving conditions. SQL scripts and sanitized results in `evidence/`.
- **Not run:** `bin/check`, real-Postgres integration suites or application build during plan-only audit. No disposable integration database was provisioned; production was not used as a test database. Existing green unit tests do not invalidate the independent failures.

## Done when
- Every accepted finding has its specified failing regression first, a reviewed fix, and evidence of passing behavior; unverified provider assertions are verified or dropped.
- Mandatory SDK host-tool denial and redaction tests remain enabled; isolation, model preservation, scope and no-retry-after-bytes invariants pass.
- Cross-layer scenarios above pass using mocked upstreams and a disposable local PostgreSQL database.
- Coordinator runs `bin/check` once with that disposable `DATABASE_URL`; all lint, typecheck, unit/integration and build gates green. Run `bin/bench` for both recorded payload sizes after request-path changes; report p99 and TTFT on pinned runtime.
- `docs/idea/` behavioral claims updated in the same PR as each change. Specifically: architecture 01, domain 02, providers 03, keys 04, routing 05, translation 06, security 07, observability 08, deployment 09, SDK 11, OIDC 13.
- Secret issue #87 is not called complete until credential rotation/session invalidation is evidenced; removing a literal alone is insufficient.
- Production rollout/backfill follows a separately reviewed concrete change. Post-release read-only comparison shows accurate closed-day counts and priced-model coverage. No destructive repair is implied by this audit.

## Risks / open questions
- Rollup fixes require a coordinated migration and bounded backfill. Older raw data may already be unavailable; never replace trusted historical aggregates with partial surviving rows.
- `k3` price alias requires verified model equivalence/current provider pricing. Unknown is preferable to an invented bill.
- Multi-replica defects are code-confirmed scenarios; this deployment currently runs one replica. Retain that bound until key limits, SDK ownership and all shared-state issues are addressed.
- Existing old partial report contained unsupported deployment-drift/forgotten-quota claims; 13 explains why they are excluded. It remains untouched as user material.
- Production validity/reuse of the committed password is untested. Actual customer content/credential compromise is not established.

## Not covered
Exhaustive vendor/protocol drift, all browser/accessibility combinations, prior/rotated container logs, GlitchTip event history, actual backup restore/PVC recovery, production fault injection, real token refresh or inference, full multi-replica load, every historical migration path. Backup success is not a restore proof. Coverage limits in individual slices are additive.
