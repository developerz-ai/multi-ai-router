# 02 — Authentication and key lifecycle

> Part of [`overview.md`](overview.md). Depends on: DB slice for atomic repositories; 01 for route/middleware adapters. Owns: `apps/api/src/services/admin-auth/`, `apps/api/src/services/dataplane/auth/`, `apps/api/src/services/crypto/`, `apps/api/src/services/keys/`, `.ui-debugger-mcp.json`, and associated tests. No secret values in this plan.

## Findings

### 02.1 high — Literal admin password remains committed
- **Where:** `.ui-debugger-mcp.json:13`; existing GitHub issue #87, still OPEN.
- **Defect:** Tracked debugger configuration contains a nonempty literal admin password instead of a runtime secret reference.
- **Failure scenario:** Repository readers/history consumers recover the password and can try it against the admin plane; a live or reused value grants privileged key administration. Presence in current HEAD confirmed without printing it. Current production validity was not tested.
- **Fix:** Replace with runtime secret injection supported by the debugger; remove the literal from current source, scan current tree/history without printing matches, rotate the exposed credential wherever used, and invalidate sessions issued under it. Coordinate history cleanup with maintainers; do not force-push main. Retain issue #87 as the operational rotation tracker.
- **Test:** Secret scan detects a seeded fake literal but accepts the chosen reference form. Verify debugger login through injected test credentials. Rotation/session invalidation validated operationally without including values in evidence.

### 02.2 high — In-flight key verification repopulates cache after revocation
- **Where:** `apps/api/src/services/dataplane/auth/verifier.ts:135`, `:146`, `:151`, `:156`.
- **Defect:** Invalidation removes completed cache entries but does not invalidate pending repository/scope loads.
- **Failure scenario:** Verification reads a usable key, pauses loading scope; admin revokes/narrows it and calls invalidate; old verification then caches the stale grant → subsequent new requests still authenticate for the full TTL. Deferred-loader reproduction accepted the revoked key with only one DB lookup.
- **Fix:** Track invalidation generations across async loads and discard/retry stale results before caching. Bound/single-flight misses per digest; ensure invalidateAll and expiry during load obey the same check. Apply immediate-local semantics without adding DB work on warm hits.
- **Test:** Pause each await, revoke/narrow/expire key, release it, then issue a new request; assert denied/narrow scope and no stale cache installation. Cover same-key concurrent misses and invalidateAll.

### 02.3 high — A stale session slide can recreate a logged-out session
- **Where:** `apps/api/src/services/admin-auth/postgresSessionStore.ts:97`, `:100`, `:113`.
- **Defect:** Session creation and sliding activity both use repository upsert; cached sessions can reinsert a deleted row.
- **Failure scenario:** Replica B caches a session, replica A logs it out and deletes the row, then B authenticates/slides its stale cached copy → upsert recreates the session, allowing subsequent misses/restarts to authenticate a supposedly revoked cookie. Two real store instances over a fake shared repository reproduced reinsertion. In-flight same-process saves also lack revocation fencing.
- **Fix:** Separate create from conditional touch of an existing, unexpired session. A touch must never insert. Fence pending loads/touches after local logout; provide bounded inter-replica revocation visibility. Coordinate DB repository changes rather than putting SQL in this service.
- **Test:** Two stores with one controlled repository: cache on B, logout on A, slide on B, cold read on C remains denied. Also pause touch/read around local logout and assert the row/cache cannot resurrect.

### 02.4 high — Concurrent password attempts bypass the expensive-work throttle
- **Where:** `apps/api/src/services/admin-auth/service.ts:291`, `:304`, `:306`.
- **Defect:** Throttle admission occurs before async password verification, but failures are counted only after verification completes; no in-flight admission budget exists.
- **Failure scenario:** One IP opens hundreds of simultaneous wrong-password logins before the first Argon2 finishes → every request sees zero failures and runs memory-expensive password verification despite a five-attempt limit, starving inference on the same process. A deferred-verifier reproduction admitted all 20 concurrent calls with `maxFailedAttempts: 2`.
- **Fix:** Reserve a bounded per-IP attempt/in-flight slot before expensive work; settle it on success/failure and retain generic responses. Add a configurable global hashing concurrency bound so many source addresses cannot exhaust process memory. Do not remove constant-work absent-password handling.
- **Test:** Deferred verifier, one IP, N simultaneous calls exceeding the configured maximum; only the allowed number reach verify, others receive bounded 429/Retry-After. Cover exceptions and released slots.

### 02.5 medium — Public OIDC start creates unlimited state rows
- **Where:** `apps/api/src/services/admin-auth/service.ts:211`; route adapter `routes/admin/auth.ts` `/oidc/start`.
- **Defect:** OIDC start does not receive an IP or call the login throttle before discovery/state issuance.
- **Failure scenario:** An unauthenticated caller loops GET `/api/admin/auth/oidc/start` → every successful call encrypts and inserts an OAuth-state row until retention catches up; no configured login limit applies.
- **Fix:** Add an IP-aware bounded OIDC-start admission path before discovery and persistence, with the same trusted-proxy policy as local login. Coordinate the route adapter with 01. Count starts rather than waiting for a callback failure.
- **Test:** Hit start over the configured limit with mocked IdP and state repository; assert bounded creates, 429/Retry-After, separate-IP behavior, and no fresh bucket from untrusted forwarded headers.

### 02.6 medium — OIDC discovery/JWKS deadline is disconnected
- **Where:** `apps/api/src/services/admin-auth/oidc/flow.ts:91`, `:95`.
- **Defect:** The shared fetch wrapper starts an AbortController timer but passes `init` unchanged; its signal never reaches fetch.
- **Failure scenario:** IdP discovery or JWKS stalls → the advertised ten-second timer fires without cancelling I/O, leaving admin sign-in requests pending indefinitely. Local fake-fetch inspection confirmed no signal was provided. The standalone discovery helper is correct but is not this production flow.
- **Fix:** Compose caller cancellation with the configured deadline and pass it to the actual fetch; ensure body reading remains bounded too. Consolidate duplicate discovery behavior instead of keeping an unused correct wrapper beside a broken one.
- **Test:** Fake fetch waits for abort; advance injected deadline and assert start/complete terminate with generic auth error. Cover JWKS, body stall, cleanup, and inherited signal.

### 02.7 medium — ID-token checks omit issued-at and authorized-party validation
- **Where:** `apps/api/src/services/admin-auth/oidc/idToken.ts:171`, `:187`.
- **Defect:** `iat` and `azp` are parsed but never validated; audience membership alone accepts an incompatible authorized party.
- **Failure scenario:** Validly signed token with expected issuer/nonce, future `iat`, or multi-audience `aud` plus `azp` naming another client passes the verifier. A locally generated RSA token with both defects was accepted. This requires an issuer-signed token; it is not a signature bypass.
- **Fix:** Validate finite integer temporal claims and acceptable issued-at skew, expiration boundary, and authorized-party semantics against the configured client. Preserve exact configured issuer identity rather than stripping its trailing slash before token validation. Keep public failures generic.
- **Test:** Locally generated RSA tokens covering future iat, wrong/missing required azp, expiration equality, and issuer with trailing slash; valid single/multiple audience contracts pass. No live IdP.

### 02.8 high — Key mutations can leave authorization in a partially committed state
- **Where:** `apps/api/src/services/keys/service.ts:167`, `:183`, `:223`; `services/admin/coherence.ts:108`.
- **Defect:** Scope kind/targets are separate writes, and post-write audit/lookup failures prevent the wrapper from invalidating cached authority.
- **Failure scenario:** Changing scope kind succeeds but target replacement fails → key persists with incompatible old target rows. Separately, revoke succeeds but audit insert fails → API returns 500 and cached grants keep authenticating until TTL because the successful-result-only hook never runs.
- **Fix:** Use one repository transaction for key row+targets and required audit intent; invalidate committed authorization changes independently of response rendering/reporting. Coordinate the atomic repository API with DB slice and coherence wrapper with 03. Preserve fail-closed behavior throughout.
- **Test:** Inject failure at every scope-write/audit/render boundary; either the entire change rolls back or the committed state is immediately reflected by verification. Race a cache miss with the transaction using 02.2's fence.

## Steps
1. Track literal-secret remediation under #87; implementation removes the literal, operational rotation remains a separately evidenced completion condition.
2. Add adversarial cache/session/key transaction tests before changing behavior; implement repository primitives in the DB slice.
3. Bound login work and OIDC state issuance; complete deadline and claim validation.
4. Coordinate 01.8 cookie renewal and 03 mutation coherence. Update `docs/idea/04-api-keys-and-access.md`, `07-security.md`, and `13-admin-oidc.md` in the same change.

## Tests / falsified claims
- Existing unit coverage: part of 1,013 passing tests across this audit's assigned areas. Auth tests exercise sequential revocation and ordinary token rejection, not the interleavings above.
- `bin/test apps/api/test/unit/admin-auth apps/api/test/unit/services/admin-auth/oidc apps/api/test/unit/dataplane/auth.test.ts apps/api/test/unit/keys`; affected integration tests use a disposable DB.
- `bunx biome check <changed files>`; coordinator runs final typecheck and `bin/check` once.
- `docs/idea/04-api-keys-and-access.md:53`, `:74` claim OIDC start is IP-throttled; code disproves it. `13-admin-oidc.md:25` claims iat validation; absent. `07-security.md:238` says restart invalidates existing sessions after password compromise; durable Postgres sessions survive restart, so that recovery instruction is unsafe and must name an actual revocation operation.
- AES-GCM encryption, randomized nonces, envelope authentication, CSRF synchronization, separate credential planes and constant-time comparisons reviewed; no confirmed primitive-level bypass found.

## Coverage limits / done when
- Did not test the committed password against any service or replay any production session. Its continued validity and password reuse are unverified.
- Distributed revocation latency must be explicit; a local cache fix alone does not make fleet-wide immediate revocation true.
- Every listed race has a failure-first regression test; no post-revocation cache/write resurrection; bounded login resource use; claims and timeouts enforced; exposed-secret rotation evidenced without recording secrets.
