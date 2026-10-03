# 01 — Transport and data plane

> Part of [`overview.md`](overview.md). Depends on: 02 and 03 for coordinated authentication/recovery changes. Owns: `apps/api/src/routes/`, `apps/api/src/middleware/`, `apps/api/src/services/dataplane/` except `auth/`, and their tests. Provider contract changes belong to 04; shared DB/config changes belong to their slices.

## Findings

### 01.1 high — Same-dialect upstream errors can disclose upstream credentials
- **Where:** `apps/api/src/services/dataplane/relay-error.ts:22`; `attempt.ts:105`.
- **Defect:** An unclassified upstream error is returned verbatim, including any echoed credentials; only translated errors pass through redaction.
- **Failure scenario:** Upstream returns HTTP 400 JSON with the rejected API key inside `error.message` → every router-key holder receives that upstream key. A local synthetic-key reproduction confirmed the returned body contains the key. This is a confirmed disclosure path; no claim that production providers have leaked a live key was established.
- **Fix:** Redact bounded error bodies on both dialect paths, including exact attempt credential material where pattern redaction cannot recognize a provider key. Preserve ordinary successful byte-passthrough and unknown nonsecret error fields. Never log the original body during this repair.
- **Test:** Mock HTTP 400 echoing synthetic upstream key, bearer token, and generic opaque secret; assert each absent from response and logs for both dialects, with original error shape/status retained.

### 01.2 high — Automatic redirects forward custom upstream authentication to another origin
- **Where:** `apps/api/src/services/dataplane/attempt.ts:76`.
- **Defect:** Authenticated upstream requests use the default `redirect: follow` without an origin policy.
- **Failure scenario:** The configured endpoint returns a 307 to a second origin → Bun 1.4 forwards `x-api-key` to that origin. Two loopback servers reproduced the leak with a synthetic key; no real upstream contacted. Authorization-header stripping by fetch does not protect custom authentication headers.
- **Fix:** Disable automatic redirects. Treat unexpected 3xx as an account/transport failure or explicitly validate each permitted same-origin hop with bounded redirect count; never forward credentials across an unapproved origin or downgrade to HTTP.
- **Test:** Two local mock origins, 307/308 redirects; destination receives no credential or prompt. Cover allowed same-origin policy and redirect loops without buffering successful streams.

### 01.3 high — Fallback session fingerprint is neither stable nor distinct
- **Where:** `apps/api/src/services/dataplane/body/scanner.ts:222`; `body/read.ts:149`.
- **Defect:** The scanner hashes the entire bounded conversation prefix, while string-valued Responses `input` contributes no bytes.
- **Failure scenario:** A short first turn hashes `[user]`; appending assistant/user turns changes the hash until the 1,024-byte ceiling, losing affinity and SDK session continuity. Conversely, two unrelated `input: "..."` requests under one key both hash the empty prefix and share one binding. Locally reproduced both outcomes. SDK lineage checks may detach individual turns; they do not make these binding keys distinct. Separate SDK fingerprint/index tenant-isolation defect belongs to 05; coordinate identity tests without duplicating that finding.
- **Fix:** Derive fallback identity from one stable, bounded initial user item, including string input, with explicit treatment of system/developer prefixes. Keep explicit session headers authoritative. Document unavoidable identical-opening collisions; never claim raw whole-transcript prefixes identify conversations uniquely.
- **Test:** Same opening plus appended turns retains fingerprint; distinct Responses strings differ; chunk boundaries/UTF-8/long first items are invariant. Exercise bound SDK requests, not just hashes.

### 01.4 high — Scanner and upstream disagree about the requested model
- **Where:** `apps/api/src/services/dataplane/body/scanner.ts:142`, `:157`.
- **Defect:** Captured JSON strings are UTF-8 decoded but not JSON-unescaped; duplicate `model` uses first-wins and scanning can stop before subsequent occurrences.
- **Failure scenario:** `"clau\\u0064e"` is routed/logged as the literal escape while an upstream JSON parser sees `claude`. `{"model":"first","messages":[],"model":"last"}` routes and records `first` while ordinary upstream parsing executes `last`; rewriting the first span does not fix it. Both mismatches reproduced locally.
- **Fix:** Decode only bounded routing string tokens correctly, preserving raw byte spans and opaque payload bytes. Reject ambiguous duplicate top-level model fields before dispatch rather than substituting a model. Account for escaped field names. Avoid whole-body JSON parse/re-serialization on passthrough.
- **Test:** Escaped keys/values, surrogate pairs, escapes split between chunks, duplicate fields before/after the conversation prefix and aliases; assert executed model equals recorded/resolved model or request is rejected before upstream.

### 01.5 high — A concurrent successful response erases a terminal account verdict
- **Where:** `apps/api/src/services/dataplane/health.ts:258`; `chain.ts` success branch.
- **Defect:** `recordSuccess()` unconditionally resets the breaker to active, unlike failure/rate-limit folds that preserve terminal states.
- **Failure scenario:** Two attempts are already in flight; one returns exhausted/402 or OAuth auth failure, then the older request returns 200 → the terminal live state becomes active before its asynchronous durable status write is visible. A local state reproduction produced `exhausted → active`. An already-reported cooldown is erased similarly.
- **Fix:** Associate verdicts with attempt generations/timestamps and preserve newer blocked/cooling states against stale successes. Only a deliberate recovery or eligible probe may clear the corresponding verdict; keep post-success rate-limit folding.
- **Test:** Deferred concurrent 402/200, OAuth 401/200, and 429/200 responses in both completion orders. Assert no later request reaches the unavailable account and terminal status remains stable.

### 01.6 high — Large translated requests exceed the overhead budget
- **Where:** `apps/api/src/services/dataplane/orchestrator.ts:75`, `:93`; `services/dataplane/translate-body.ts`; `apps/api/bench/harness.ts:89`.
- **Defect:** The existing local benchmark exceeds the <5 ms p99 budget for 280 KB translated prompts; production's overhead metric additionally includes client-body delivery time, so its larger values cannot be read as pure processing time.
- **Failure scenario:** `DATABASE_URL='' bin/bench --requests 1000 --warmup 100 --prompt-bytes 280000 --json` exits 1: translate p99 11.11 ms, translated streaming 10.00 ms. Same settings with the default 1,024-byte prompt pass (all p99 <=1 ms). Both runs have zero request failures and zero buffered streams. Large streaming added TTFT p95 remains <0.1 ms.
- **Production evidence:** 161 no-account quota rejections/24h average 75.84 ms, p99 245.6 ms; 109 successful Kimi attempts average 95.47 ms, p99 256 ms. These require attribution rather than a claim of 50x processing cost.
- **Additional proof:** Existing benchmark harness with a tiny body delayed 100 ms before delivery records 101 ms of router overhead; the immediate-body first request records 7 ms. Upload wait is included by `orchestrator.ts:75` and subtracted from neither timing bucket. See `evidence/upload-timing.txt`; this is a timing-boundary demonstration, not a throughput benchmark.
- **Fix:** Profile large-body translation and its repeated work; instrument separate body-wait, scanner, binding, selection, credential and translation spans. Keep an honest total-latency measure, plus a clearly defined added-processing measure. Optimize proven causes without changing model selection, byte-passthrough or stream forwarding.
- **Test:** Preserve both benchmark JSON reports in `evidence/bench-1k.json` and `evidence/bench-280k.json`; repeat same options after changes on the pinned runtime. Add controlled delayed-body and cold/warm-session cases. Require <5 ms p99 and unchanged TTFT on agreed supported workloads; document environment/noise rather than relabeling a breach away.
- **Evidence limit:** Local Bun is 1.4.0 and production/release pins 1.4.2. Benchmark uses in-memory repositories and omits production session-store I/O. The cause of production's larger observations remains unverified; same-dialect full JSON reserialization was not found.

### 01.7 medium — Error-body classification buffers an unbounded response
- **Where:** `apps/api/src/services/dataplane/attempt.ts:196`.
- **Defect:** Every HTTP failure calls `response.text()` with no byte ceiling before classification/failover.
- **Failure scenario:** A faulty compatible endpoint streams a very large 500 body within the attempt deadline → the router allocates the whole body, then parses another copy, multiplying memory under concurrent failed requests and delaying failover.
- **Fix:** Add a configurable bounded failure-body reader, cancel the upstream body when the ceiling is reached, and preserve status/rate-limit classification from the bounded prefix. Mark truncation without returning secret fragments.
- **Test:** Mock error stream exceeding the ceiling; assert cancellation, bounded retained bytes, prompt next-account attempt, and one failure UsageRecord. Successful streams remain byte-for-byte relays.

### 01.8 medium — Browser cookie does not slide with the session
- **Where:** `apps/api/src/middleware/adminAuth.ts:78`; `routes/admin/auth.ts:91`, `:133`; `services/admin-auth/service.ts` authenticate slide.
- **Defect:** Only login writes `Set-Cookie`; authenticated requests extend server expiry without renewing cookie Max-Age.
- **Failure scenario:** Configure idle=8h, absolute=24h; operator remains active all day → browser discards the original cookie at hour eight although `/session` reports an extended expiry.
- **Fix:** Renew the cookie on authenticated browser-session activity, bounded by remaining absolute lifetime and coalesced where appropriate. Use the existing signed value and cookie helper; never issue a cookie for static bearer authentication. Coordinate any service-return metadata with 02.
- **Test:** HTTP test with injected clock: activity renews Max-Age, absolute cap still wins, idle sessions expire, bearer calls set no cookie, secure/insecure names remain consistent.

### 01.9 medium — A failed response stream is recorded as successful usage
- **Where:** `apps/api/src/services/dataplane/chain-relay.ts:74`, `:95`, `:115`.
- **Defect:** The relay's error observer calls the same `settle` function as a clean end, which always records `SUCCESS_OUTCOME` and `errorClass: null`.
- **Failure scenario:** Upstream sends HTTP 200 and a first SSE chunk, then its readable stream errors → client receives a truncated answer while usage reports a successful attempt. This applies to transport reader failures even if no provider-specific terminal error frame exists.
- **Fix:** Carry clean-end versus error/cancellation outcome into accounting, preserve partial token/timing readings and original upstream HTTP status, and record an appropriate error class. Distinguish client cancellation where evidence permits. Never retry after emitted bytes.
- **Test:** Local mock ReadableStream emits a chunk then throws; assert exactly one failed UsageRecord with partial usage and no attempt on a second account. Also cover clean end, translated stream error, and deliberate client cancellation.

## Steps
1. Add failure-first reproductions for credential handling, scanner/session identity, verdict ordering and cookie renewal.
2. Repair bounded transport edges and state sequencing. Coordinate 03.3's encrypted OAuth metadata with this slice's `egress/credential.ts` reader and 04's provider contract.
3. Measure 01.6 with mock traffic, then change only identified spans. No live provider benchmark.
4. Update `docs/idea/05-routing-and-failover.md`, `06-protocol-translation.md`, `07-security.md`, and `13-admin-oidc.md` alongside the behavioral changes.

## Tests / existing evidence
- Audit: 1,013 existing unit tests across routing, dataplane, auth, accounts, pools, keys and catalog passed; no real DB, provider, or Claude subprocess used. Passing tests omit the adversarial cases above.
- Re-run targeted `bin/test apps/api/test/unit/dataplane apps/api/test/integration/dataplane.test.ts` with a disposable test DB for integration only; cookie tests in `apps/api/test/integration/admin-auth.test.ts`.
- `bunx biome check <changed files>`; coordinator runs `bin/lint (includes typecheck)`, `bin/check` with test `DATABASE_URL`, and `bin/bench` once.

## Falsified claims / coverage limits
- Scanner comments claim distinct/stable conversation fingerprints; 01.3 disproves both for ordinary inputs.
- The security invariant covers errors too; same-dialect exception in `relay-error.ts` contradicts it.
- Did not inspect arbitrary production response bodies, replay customer prompts, or infer credential compromise. Streaming success relay and existing no-retry-after-bytes tests reviewed; no confirmed success-stream buffering defect.
- Full cancellation/backpressure/load behavior requires the local controlled integration/benchmark work above.

## Done when
- Each reproduced failure has a regression test; successful same-dialect bodies/streams remain opaque and unchanged.
- Credentials cannot escape via the two confirmed transport paths; model selection and session bindings agree with actual dispatched requests.
- Overhead breach has measured causality and a verified fix, or remains explicitly open with evidence rather than being relabeled away.
