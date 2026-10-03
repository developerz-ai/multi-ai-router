# 03 — Routing, account lifecycle and warm catalogs

> Part of [`overview.md`](overview.md). Depends on: DB slice for transactional/conditional repository operations; 04 for provider credential metadata contract. Owns: `apps/api/src/services/routing/`, `accounts/`, `pools/`, `admin/`, `health/`, `models/`, `catalog/`, and their tests. Transport health store, egress credential reader and middleware belong to 01; key services belong to 02.

## Findings

### 03.1 high — Healthy overflow binding is silently ignored when a primary recovers
- **Where:** `apps/api/src/services/routing/select.ts:35`, `:97`, `:130`.
- **Defect:** Binding evaluation admits the overflow member, but group resolution omits it whenever any primary is eligible; hoisting an absent candidate silently does nothing.
- **Failure scenario:** Primary was unavailable, session was created on overflow, primary recovers → decision says `binding: honored` for overflow while candidate list contains only primary. Local pure-function reproduction returned exactly that mismatch, so SDK history moves without a restart warning.
- **Fix:** Include an eligible bound overflow in the candidate set regardless of normal overflow gating, with scope intersection intact. Assert every honored binding exists at the head after final planning; do not silently reinterpret it as a preference.
- **Test:** Establish overflow-bound session, recover primary under every policy; overflow stays first. Cover out-of-scope/disabled/blocked overflow and restart signaling when invalidation is legitimate.

### 03.2 high — OAuth reconnect does not clear the live authentication block
- **Where:** `apps/api/src/services/accounts/connect/fromEnv.ts:164`; `refresh/refresher.ts:189`.
- **Defect:** Non-Claude token writes only re-arm refresh timers; they do not reset stale live auth failure state or synchronously refresh the catalog. Ordinary successful refresh notifies catalog only if an old row was needs_reauth.
- **Failure scenario:** OpenAI OAuth attempt marks live breaker needs_reauth; operator reconnects successfully, row becomes active/new token → catalog timer eventually updates the row but live needs_reauth still overlays it indefinitely. Fresh connects and active-account refreshes also serve stale catalog credentials until the timer.
- **Fix:** Add one post-credential-commit recovery hook: refresh committed credentials, clear only the obsolete auth verdict with generation fencing, and re-arm expiry scheduling. Wire for connect/reconnect/refresh; preserve operator disabled status and unrelated current quota verdicts. Follow the explicit Claude recovery wiring without reading Claude tokens.
- **Test:** Full mocked account lifecycle: auth failure → reconnect → next request uses new token and succeeds without restart/TTL wait. Race old failed attempts with reconnect; late failures must not re-park fresh credentials. Cover ordinary active-account refresh visibility.

### 03.3 high — Accepted ChatGPT identity is discarded before dispatch
- **Where:** `apps/api/src/services/accounts/connect/oauth-exchange.ts:131`; `refresh/credential.ts`; downstream `services/dataplane/egress/credential.ts:63`; provider `drivers/openai-oauth.ts` readTokens/requireChatGptAccountId.
- **Defect:** Provider token parsing accepts identity from id_token, but the stored encrypted credential retains only access/refresh tokens and later dispatch derives identity solely from access-token claims.
- **Failure scenario:** Successful token response has ChatGPT account ID in id_token and an opaque/access token without that claim → connect reports success, first dispatch cannot build the required account header. Repeating login does not restore the discarded field.
- **Fix:** Preserve validated provider account identity in the encrypted credential through initial exchange and refresh, retaining prior identity only when the refresh contract permits. 04 owns provider types/header support; 01 owns egress credential reader. Do not add provider constants or special-case switching to routing.
- **Test:** Fake unsigned token-shaped fixtures used only by provider claim extraction, no real credentials: identity in id_token only, access token only, identity rotated on refresh, missing identity rejected; actual mocked dispatch gets the expected header. Never return identity token/credentials to admin responses.

### 03.4 high — Post-write catalog refresh can reuse a pre-write snapshot
- **Where:** `apps/api/src/services/catalog/store.ts:61`; `services/admin/coherence.ts:43`.
- **Defect:** Refresh coalesces all callers into an existing load even when the caller needs a snapshot newer than its committed mutation.
- **Failure scenario:** Periodic load reads old membership/status and pauses; admin narrows a pool/disables an account, then awaits refresh → it joins the old load and returns success with stale routing authority until next interval. Local deferred-loader reproduction showed post-write and pre-write calls shared the same promise and only one load ran.
- **Fix:** Distinguish ordinary refresh coalescing from an invalidation barrier; a post-write request must guarantee a load started after that write or a newer generation. Keep atomic snapshot installation and retain last good data on read failure.
- **Test:** Pause old load, commit mutation, call refresh barrier, complete old load; admin success waits for a second/newer load. Verify next request cannot select removed/disabled accounts; cover multiple concurrent admin mutations.

### 03.5 medium — Re-check leaves persisted spent quota blocking the account
- **Where:** `apps/api/src/services/accounts/recheck.ts:134`, `:140`; `services/dataplane/snapshot.ts` quota overlay.
- **Defect:** Re-check drops in-memory health and optionally clears exhausted status, but leaves durable quota windows and the catalog's spent readings intact.
- **Failure scenario:** Provider resets quota early while stored five-hour window still says utilization=1 with a future reset → operator presses Re-check → next selection rehydrates that spent window and returns 429 without issuing the promised probe.
- **Fix:** Make explicit recheck create a bounded, generation-tagged one-probe admission that can test the stale quota verdict, without fabricating a provider utilization reset. Persist/protect the recovery intent as needed, then replace evidence only from the probe result. Update visible reported/estimated/unknown provenance honestly.
- **Test:** Stored future spent window plus empty live state, press recheck, exactly one mocked request reaches upstream; success refreshes state, 429 preserves/corrects reset. Cover other replicas and repeated presses.

### 03.6 medium — Re-check resets directly to active, bypassing its advertised one-probe gate
- **Where:** `apps/api/src/services/accounts/recheck.ts:134`; transport dependency `services/dataplane/health.ts:322`.
- **Defect:** `health.reset` deletes breaker state; its replacement is healthy/active, not half-open, so re-check's claimed probe gate never applies.
- **Failure scenario:** Rate-limited API-key account has no persisted quota window; re-check clears its cooldown and a concurrent backlog all sees active → many requests hit the upstream before a new verdict, despite comments promising exactly one.
- **Fix:** Reuse an explicit half-open recovery operation, separate from forgetting/deleting an account. Coordinate transport health-store change with 01 and the persisted-quota behavior in 03.5.
- **Test:** After recheck, launch concurrent requests against a deferred upstream; one admitted until the verdict, then either reopen healthy or restore cooldown. Deletion/credential replacement keep their distinct reset semantics.

### 03.7 high — OAuth refresh single-flight is only process-local
- **Where:** `apps/api/src/services/accounts/refresh/refresher.ts:92`, `:208`; `refresh/exchange.ts` token read/write.
- **Defect:** Each replica has independent timers/flight maps and exchanges the same rotating refresh token without a shared per-account lock; comments incorrectly call refresh idempotent.
- **Failure scenario:** Two replicas read refresh token R; first exchanges to R2, second exchanges already-spent R and is refused → second may park the account needs_reauth although a valid replacement exists, or invalidate the rotated grant according to provider behavior.
- **Fix:** Take a short-lived per-account Postgres advisory lock through a repository/helper before reading current credential and performing refresh; re-read under lock, handle contention by re-arming from committed expiry, and release reliably. No polling broker and no Claude-token access. Fence reconnect versus stale refresh writeback.
- **Test:** Two independent refresher instances sharing a fake rotating issuer/repository/lock; only one exchange of R, loser observes R2, no false reauth. Cover lock contention, owner shutdown, and reconnect during refresh. Provider grant invalidation on reuse is unverified; duplicate spending and false park follow directly from code.

### 03.8 high — Background authentication results can overwrite a newer operator disable
- **Where:** `apps/api/src/services/accounts/refresh/status.ts:35`, `:59`; `services/health/claudeAuthProbe.ts:97`, `:104`; `accounts/connect/oauth-exchange.ts:142`.
- **Defect:** Decisions use status captured before async network/CLI work, then write status unconditionally.
- **Failure scenario:** Probe reads needs_reauth, operator disables account while CLI runs, probe returns loggedIn → writes active over disabled. Refresh failure similarly changes a newly disabled row to needs_reauth; OAuth completion can resurrect a disabled pending account.
- **Fix:** Conditional repository transitions on expected current status and credential/account generation. Report/audit only transitions actually committed. Use `updateStatusWhen` pattern already present in recheck/credential parking; extend with generation where stale credentials matter.
- **Test:** Pause probe/refresh/exchange, disable/delete/reconnect account, release response; operator's newer decision survives and audit reports no fictional transition.

### 03.9 medium — Pool row and membership replacement are not one mutation
- **Where:** `apps/api/src/services/pools/service.ts:163`, `:175`; create has the same split.
- **Defect:** Policy/overflow row update commits separately from membership replacement and audit; validation does not make those writes atomic.
- **Failure scenario:** An update changes overflow and members, but member replacement fails due a concurrent account delete/DB fault → persisted overflow points outside the old member set, routing silently drops it, and the request failed after changing policy. Failed audit can also skip catalog invalidation after a real mutation.
- **Fix:** One repository transaction for pool row+members and required audit intent, returning committed data; post-commit catalog invalidation independent of render failures. DB slice owns the transactional repository, this slice owns callers/coherence; pair with 02.8's equivalent key flow.
- **Test:** Fault injection between statements and concurrent deletes; failed mutation preserves old complete pool or a committed new complete pool with refreshed routing, never a partial mix.

## Steps
1. Land pure overflow-binding regression, then repair candidate construction.
2. Add DB atomic/conditional/lock primitives with the DB owner. Update key coherence for 02.8 and pool coherence here.
3. Repair credential lifecycle hooks and metadata persistence across 04 → 01 → this slice; add controlled stale-completion tests.
4. Introduce recheck recovery admission and generation-aware catalog barriers; preserve operator status and quota provenance.
5. Update `docs/idea/01-architecture.md`, `03-providers.md`, `05-routing-and-failover.md`, `07-security.md`, and `11-anthropic-agent-sdk.md` with the exact behavior.

## Tests / falsified claims
- `bin/test apps/api/test/unit/routing apps/api/test/unit/accounts apps/api/test/unit/pools apps/api/test/unit/catalog`; new catalog concurrency test file needed. Integration fixtures must use a disposable PostgreSQL DB and mocked OAuth/CLI.
- Audit's selected suites: 1,013 tests passed across 62 files. Pure reproduction independently proved overflow mismatch; deferred promises proved stale catalog reuse. Sequential tests do not cover these interleavings.
- `bunx biome check <changed files>`; coordinator runs final typecheck/`bin/check`/`bin/bench` once.
- `recheck.ts` claims a half-open, single-probe recovery; reset produces active and spent persisted windows can prevent any probe.
- `catalog/store.ts` claims admin read-after-write consistency; joining a pre-write load disproves it.
- `refresh/refresher.ts` claims duplicate refresh is idempotent; rotating grants make that false. `refresh/status.ts` and `claudeAuthProbe.ts` promise disabled stays disabled; stale unconditional writes disprove it.

## Coverage limits / done when
- Reviewed account CRUD/connect/refresh/recheck, policies/filter/scope/binding, catalog hydration, model listings and health probes. Did not execute live model discovery, refresh tokens, CLI login, or customer inference.
- Additional unverified leads: model-specific quota windows may over-filter other model families; earliest blocked-window selection can understate the actual all-windows recovery time. Require targeted spec/provider-contract confirmation before counting as findings.
- Pool membership never widens during partial writes; honored binding always selects its account; a completed credential recovery is usable on the next request; operator disable survives late work; one recheck creates at most one probe; refresh spends each rotating token once across replicas.
