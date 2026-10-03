# 03 — Providers & Claude Agent SDK

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/providers/**` (drivers, failure/, rate-limit/, model-alias, claude-sdk/**), `apps/api/src/services/accounts/connect/claude*.ts`, matching tests under `apps/api/test/unit/providers/`, `apps/api/test/unit/claude-sdk/`.

Security gate re-verified, no finding: every `query()` site (`options.ts:184`, `idle-query.ts:176`, `test-probe.ts:194`) sets `settingSources: []`, `strictMcpConfig`, `skills: []`, `tools: []`, `allowedTools` from the frozen empty `PERMITTED_TOOLS`, `permissionMode: "dontAsk"`, deny-by-default `canUseTool`; passthrough MCP handler only refuses (`tools/passthrough.ts`); `ANTHROPIC_*` stripped by prefix (`env.ts:405`); `config_dir` has a unique index, so no two Accounts can share a `CLAUDE_CONFIG_DIR`.

Dive 2 security answer: **a client tool named `Bash`/`Read` cannot reach the built-in.** Client tools are registered only on the in-process MCP server `client`, so the model sees `mcp__client__Bash` (`tools/names.ts`). Built-ins are elided by `tools: []`. Every call (built-in or MCP) still hits the empty-allowlist `canUseTool` deny plus the matcher-less `PreToolUse` deny hook (`tools/early-stop.ts:296-302`). The MCP handler only returns a refusal (`tools/passthrough.ts`). No finding.

Dive 2 render check, no finding: event order, monotonic client indices across thinking/text/tool_use and subagent blocks (`render/index-map.ts`), and `input_json_delta` buffering with flush of held tool blocks (`tools/early-stop.ts:230-262`) all hold. `stop_reason` is passed through verbatim (`tool_use` / `max_tokens` / `end_turn` / `refusal` / `pause_turn`); early stop states `tool_use`. `message_delta.usage` carries input, output and cache tokens from `result` (`render/frames.ts` `outputCounts`). A mid-stream failure becomes a terminal `event: error` frame. The 15 s `: ping` comment is used as the keep-alive. The SDK path renders Anthropic only, and OpenAI dialects go through `services/translate` (slice 04). Sampling knobs (`temperature`, `top_p`, `max_tokens`, `stop_sequences`) are dropped silently, which is the spec's documented choice (`docs/idea/11-anthropic-agent-sdk.md:78,817`). It is not a bug, but if you want a 400 instead, the spec has to change first.

## Findings

### 03.1 high — One stale `rejected` SDK bucket puts every later successful turn into cooldown
- **Where:** `apps/api/src/providers/claude-sdk/quota.ts:105-122`, `:209-233`; consumed at `services/dataplane/sdk-attempt.ts:297` → `services/dataplane/chain.ts:160` → `services/dataplane/health-reading.ts:54-66`.
- **Defect:** `ingest` returns a snapshot of **all** buckets the account ever reported, and a bucket's `limited: true` is only cleared by a later event naming that same `rateLimitType`; nothing expires it when its `resetsAt` passes (and `futureEpoch` drops past instants, so `previous.resetsAt` is carried forever).
- **Failure scenario:** turn A gets `rate_limit_event {rateLimitType:"seven_day", status:"rejected", resetsAt:T}`. After T the CLI's representative event is `{rateLimitType:"five_hour", status:"allowed"}`. Every turn now: `ingest` → snapshot `limited:true` (stale seven_day bucket) → success path `applyRateLimit` → `foldRateLimit` → `recordFailure` → healthy account flips to `cooling_down` after each **successful** 200, resets from a past instant / backoff. Lasts for the life of the process.
- **Fix:** make `snapshotOf` take `now` and treat a bucket as limited only while `resetsAt === undefined || resetsAt > now`; in `ingest`, when `reading.resetsAt` is null and `previous.resetsAt <= now`, drop the stale reset instead of carrying it (`quota.ts:116`). Optionally clear every bucket's `limited` when an `allowed` event arrives with no `rateLimitType`-specific rejection outstanding past its reset.
- **Test:** unit `test/unit/claude-sdk/quota.test.ts` — ingest seven_day rejected (resetsAt = now+1h), then at now+2h ingest five_hour allowed → `signal.limited === false`. Failure case first.

### 03.2 high — Streaming idle-guard timeout (and any post-first-byte failure) never terminates the subprocess
- **Where:** `apps/api/src/providers/claude-sdk/render/respond.ts:86-95`, `render/stream.ts:441-448`, `turn-lifecycle.ts:504-517`, `tools/early-stop.ts:220-229`, `invoker.ts:293-342`.
- **Defect:** once the SSE response exists, a failure in `drain` only calls `pump.close()` → `iterator.return()`; the iterator is an async generator (`observeTurn` / `passthrough.filter`) suspended in `await inner.next()`, and async-generator `return()` is queued behind that pending `next()`, so the epilogue never runs and nothing calls `launch.abort()` (the invoker's `catch` is only reached before the Response is returned).
- **Failure scenario:** subscription stream stalls 90 s mid-answer → `UpstreamTimeoutError` → client receives terminal `error` frame, stream closes, client stays connected/happy → subprocess keeps running (≈245 MB) and keeps its per-Account + global concurrency slot until `UPSTREAM_TIMEOUT_MS` (default 600 s) aborts the signal. A few stalls wedge an Account at `CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT`; every queued request waits. Violates §9 "never orphan a subprocess".
- **Fix:** add `onFailure`/`terminate` to `SdkRenderInput` (`render/stream.ts:220`); `sseResponse` catch (`respond.ts:89`) and `cancel()` (`respond.ts:98`) call it before `pump.close()`; invoker passes `(e) => started.abort(e)` (`invoker.ts:293`). Abort kills the subprocess, which settles the pending `next()` and lets `observeTurn`'s epilogue release the slot. Do **not** call it on a normal finish (gauge needs the process alive).
- **Test:** unit `test/unit/claude-sdk/invoker.test.ts` — stubbed `runQuery` yields one `stream_event` then never resolves; injected ticker fires idle → assert `options.abortController.signal.aborted === true` and `concurrency.inFlight === 0` after the body is read to end.

### 03.11 medium — Unparseable `/v1/messages` body on a Claude sub runs a billed empty-prompt turn
- **Where:** `apps/api/src/providers/claude-sdk/request.ts` `readSdkRequest` (`return EMPTY` on JSON or schema failure); `prompt.ts` `buildSdkPrompt` (`send.length === 0` → `[text("")]`); `invoker.ts:238-239`.
- **Defect:** any schema miss (one content block without `type`, `messages` not an array, `messages: []`) silently becomes `EMPTY`. A same-dialect body gets no other validation: preflight checks only `model`.
- **Failure scenario:** verified: `{"model":"claude-…","stream":true,"system":"be terse","messages":[{"role":"user","content":[{"text":"hi"}]}]}` → `{messages:[],system:null,tools:[],stream:false}` → prompt `[{"type":"text","text":""}]`. The subprocess spawns and a real subscription turn is billed against an empty prompt. The client asked for SSE and gets JSON, and the system prompt and tools are dropped. Anthropic's API would answer `400 invalid_request_error`.
- **Fix:** have `readSdkRequest` throw a router-authored sentence on JSON or schema failure, or on an empty `messages`. Add a matching phrase to the `invalid-request` row in `failure-rules.ts:64-73`. Keep it per-field tolerant (unknown block types are already handled by `renderBlock`), but a body that is not a Messages request is a `400`, not a turn.
- **Test:** unit `test/unit/claude-sdk/request.test.ts`: the body above throws and `classifySdkFailure` → `invalid-request`/400. Integration (SDK stubbed at `query()`): the stub is never called and the client gets 400.

### 03.4 medium — Body-stated quota reset ignored on compatible drivers; adjacent wording flips it to permanent `402` (prod 06.5)
- **Where:** `apps/api/src/providers/drivers/openai-compatible.ts:9-13`, `drivers/anthropic-compatible.ts:13-17`, `drivers/compatible-rules.ts:22-29`, `rate-limit/parse.ts:136-147`.
- **Defect:** (a) neither escape-hatch driver reads a reset out of the error body, so a 429 that names its reset gets `resetSource: "unknown"` and the breaker invents an estimated backoff; (b) `genericCreditsRule` matches "quota exhausted" even when the same sentence says the quota **will reset** — a clock-recoverable window classified `credits-exhausted`.
- **Failure scenario:** verified with the real driver: Alibaba token plan 429 `"Your token-plan 1-month quota has been exhausted. The quota will reset at 10-13 16:00:00 UTC."` → `{kind:"rate-limited", signal:"http-status:429", rateLimit:{limited:true, resetSource:"unknown"}}` → breaker `estimated` backoff → account re-probed for 11 days and console shows a wrong countdown. Same body reworded `"quota exhausted. The quota will reset at …"` → `credits-exhausted` → `exhausted` / `402`, never timer-retried (NN 7 violated in the other direction). A 1-month quota with a stated reset is `cooling_down` + `429` + provider-reported `Retry-After`, not `exhausted`.
- **Fix:**
  1. New pure `rate-limit/body-reset.ts`: `parseBodyReset(message, referenceDate)` reading `reset(s)? at <instant>` forms — ISO 8601, `YYYY-MM-DD HH:MM:SS`, and year-less `MM-DD HH:MM:SS` — only when an explicit zone (`UTC`/`GMT`/`Z`/`±hh:mm`) is present (never guess a zone; z.ai keeps its own `+08:00` in `zai.ts:59-80`). Year-less → first occurrence ≥ the response's `Date` header (pure: the clock comes from the response, not a driver clock); no `Date` header → skip.
  2. `compatible-rules.ts`: export `parseCompatibleRateLimit(response)` = `parseRateLimitHeaders` + body reset when `limited` (pattern of `parseZaiRateLimit`, `zai.ts:87-112`; never override a header-reported reset). Wire as `parseRateLimit` in both `openai-compatible.ts` and `anthropic-compatible.ts`.
  3. `genericCreditsRule` (`compatible-rules.ts:28`): add a negative guard — no match when the message also says `will reset|resets? at|reset in|refreshed in the next|until .* resets` (reuse the idea of Kimi's `QUOTA_REOPENS`, `kimi.ts:74`).
- **Test:** unit `test/unit/providers/rate-limit.test.ts` + `failure-vendors.test.ts`: the exact 06.5 body with `date: Fri, 02 Oct 2026 23:00:00 GMT` → `rate-limited`, `resetsAt = 2026-10-13T16:00:00Z`, `resetSource = provider-reported`; the "quota exhausted … will reset" variant → `rate-limited`, not `credits-exhausted`; a bare "insufficient balance" still → `credits-exhausted`.

### 03.12 medium — OpenRouter `403` (moderation-flagged input) parks the key as a rejected credential
- **Where:** `apps/api/src/providers/drivers/openrouter.ts:27`; status default `failure/classify.ts:82`.
- **Defect:** `codeRule("auth", …, ["401","403"])`. OpenRouter documents `403` as "your input was flagged by moderation", not a credential failure.
- **Failure scenario:** verified: `403 {error:{code:403,message:"Input was flagged by moderation"}}` → `{kind:"auth", retryable:true}`. The breaker puts the account in a `credential-rejected` cooldown and the chain retries the same flagged prompt on the next OpenRouter account. One prompt sidelines every OpenRouter key in the pool, and the client gets `502` "account needs re-authenticating" instead of the moderation refusal.
- **Fix:** match `401` only in the auth rule. Add `onStatus([403], {kind:"invalid-request", signal:"openrouter:moderation-403"})` ahead of the status default. While there, `408` (OpenRouter's timeout) → `server-error` (retryable), not the generic `invalid-request`.
- **Test:** unit `failure-vendors.test.ts`: OpenRouter 403 moderation body → `invalid-request`, `retryable:false`; 401 → `auth`; 408 → `server-error`.

### 03.3 medium — Busy-session retry: first attempt's late epilogue releases the **retry's** slot
- **Where:** `apps/api/src/providers/claude-sdk/invoker.ts:247`, `:284-289`, `:366-370`.
- **Defect:** `onEnd` closes over the mutable `let slot`, not the slot of its own attempt; the epilogue is fire-and-forget (`turn-lifecycle.ts:516`) and awaits `inner.return()`, so it can run after `slot` is reassigned for the retry.
- **Failure scenario:** resume plan, CLI answers "is running as a background session" → attempt 1 throws → outer catch releases slot 1, `ensureFresh` + `acquire` → `slot = slot2` → attempt 1's epilogue (slow `Query.return()` while the CLI tears down) fires `slot.release()` on **slot2**. Retry subprocess runs holding no permit; the per-Account gate admits one more than `perAccount`. Timing-dependent (needs `inner.return()` slower than freshness + acquire); verified by reading, not reproduced.
- **Fix:** inside `attempt`, capture `const mine = slot` (or pass the slot in as a parameter) and use `mine.release()` in `onEnd` (`invoker.ts:288`).
- **Test:** unit `invoker.test.ts` — stub whose iterator throws a busy-session error and whose `return()` resolves only after a manual gate; retry iterator blocks; open the gate → assert `concurrency.inFlightFor(id) === 1` while retry runs.

### 03.5 medium — MiniMax `200` + `base_resp` failure is never classified
- **Where:** `apps/api/src/providers/drivers/minimax.ts:7-17`, `:52-63`; `services/dataplane/attempt.ts:101-103`; contract `providers/types.ts:407-411`.
- **Defect:** the driver contract says `classifyFailure` "accepts a 2xx because MiniMax reports a dead balance in the body of a 200", but `runAttempt` returns `success` for every `status < 400` without calling it, so `base_resp` codes 1008/1002/1004 on a 200 are dead code.
- **Failure scenario:** MiniMax balance drained → `200 {base_resp:{status_code:1008,…}}` → relayed to the client as a completion, recorded success, account stays `active` and keeps taking traffic (NN 7: exhausted never detected).
- **Fix:** add an optional driver member `inspectSuccess?(status, headers, contentType): boolean` (non-stream JSON only — never buffer a stream, NN 8/10) and, in `attempt.ts`, only for drivers that declare it and only for a non-`text/event-stream` 2xx, read the body and run `classifyFailure`. Owner of `attempt.ts` is slice 01 — coordinate; the driver-side member lives in `minimax.ts` + `types.ts`. Alternative if slice 01 refuses: delete the 200 claim from `minimax.ts`/`types.ts` docs (falsified claim below).
- **Test:** integration — mocked MiniMax upstream answering `200 {base_resp:{status_code:1008}}` non-stream → client `402`, account `exhausted`, one `UsageRecord` with the failure.

### 03.6 medium — Codex refresh race across replicas → owned by 02.2
- Pointer only; fix lives in slice 02 (cross-replica refresh single-flight). Keep `refresh/exchange.ts` untouched here.

### 03.7 low — Model alias lookup resolves prototype keys
- **Where:** `apps/api/src/providers/model-alias.ts:16`.
- **Defect:** `aliases[requestedModel]` on a plain object; verified `mapModelAlias(acct, "constructor")` returns a `function`.
- **Failure scenario:** client sends `model: "constructor"` / `"toString"` / `"__proto__"` → router "maps" it to a non-string, body model rewritten to garbage (dropped by `JSON.stringify`) — a model the client never asked for (NN 4), upstream 400 with a confusing message.
- **Fix:** `Object.hasOwn(aliases, requestedModel) ? aliases[requestedModel] : requestedModel`, and require the value be a string.
- **Test:** unit `model-alias.test.ts` — `"constructor"`, `"__proto__"`, `"toString"` pass through unchanged.

### 03.8 low — `Retry-After` edge cases yield `Retry-After: 0`
- **Where:** `apps/api/src/providers/rate-limit/parse.ts:110-125`; `failure/router-error.ts:335-339`.
- **Defect:** empty `retry-after:` parses as `Number("") = 0`; reported `0` (or `retry-after-ms: 200` → 0.2) passes through `toRouterError` unfloored — only the *derived* path gets the documented ≥1 s floor (`router-error.ts:364`). Huge values are uncapped (fine for breaker, but `retry-after: 1e12` is accepted verbatim).
- **Failure scenario:** upstream 429 with `retry-after:` (empty) → client gets `429 Retry-After: 0` → lockstep immediate retries into the same wall.
- **Fix:** treat empty/whitespace as absent; in `toRouterError` apply `Math.max(1, Math.ceil(x))` to a reported value too.
- **Test:** unit `rate-limit.test.ts` — `retry-after: ""` → no `retryAfterSeconds`; `router-error` with reported 0.2 → 1.

### 03.13 low — `IDLE_PROBE_MODELS.kimi = "k2"` has no provenance and matches no Moonshot id (answer to slice 02)
- **Where:** `apps/api/src/scheduler/tasks/idle-account-probe.ts:93`.
- **Defect:** `k2` appears in none of the repo's Moonshot tables (`services/cost/tables/moonshot.ts`, `services/models/windows/moonshot.ts`: `kimi-k2*`, `kimi-k2.5/6/7-code`), and the row has no provenance comment. The Kimi Code endpoint (`api.kimi.com/coding`, `drivers/kimi.ts:20`) documents `kimi-for-coding`. `unverified` without a live call: the endpoint may ignore the model. **Prod (2026-10-02):** the `kimi` account's discovered `supported_models` = `k3, k3-256k, kimi-for-coding, kimi-for-coding-highspeed` — `k2` is not among them; successes are on `k3`.
- **Failure scenario:** the keepalive turn gets `400`/`404` → `invalid-request` → the account is not parked, but it is never warmed, so the probe is dead weight that logs a failure for every Kimi account every sweep.
- **Fix:** slice 02 owns the file. Use the id the account's own discovered catalog lists (`services/accounts/discover-models.ts`) rather than a constant, or pin `kimi-for-coding` with a provenance + blast-radius comment.
- **Test:** unit `idle-account-probe.test.ts`: the kimi probe model is a member of the Kimi catalog fixture.

### 03.14 low — Two sources of truth for a Claude account's config dir
- **Where:** data plane reads `row.configDir` (`services/dataplane/plan.ts:174`, `catalog/load.ts:117`). Login (`connect/claude.ts` `configDirs.provision(id)`), freshness (`credential-freshness.ts:333`), auth probe (`health/claudeAuthProbe.ts:72`) and credential metadata (`accounts/credential.ts:89`) use `configDirs.pathFor(id)` = `CLAUDE_CONFIG_ROOT/<id>`.
- **Defect:** the two agree only while `CLAUDE_CONFIG_ROOT` never changes after an account is created.
- **Failure scenario:** operator moves the volume (`CLAUDE_CONFIG_ROOT` changed). Turns run in the old `row.configDir`, while re-login writes the new path and the console reports "connected". Turns keep failing auth, freshness and the auth probe look at the wrong file, and the reaper treats nothing as an orphan, because the dir is named by id.
- **Fix:** one resolver. The data plane uses `pathFor(id)` (or the row everywhere). Optionally fail boot when a row's `config_dir` is outside the root.
- **Test:** unit: catalog row with `configDir` ≠ `pathFor(id)` → plan uses the same path the login writes.

### 03.15 low — Pending Claude logins are per-replica memory
- **Where:** `services/accounts/connect/claude-pending.ts` (in-process `Map`); `connect/claude.ts` `complete`.
- **Defect:** the login CLI subprocess and its `state` live on the replica that ran `begin`.
- **Failure scenario:** 2 replicas without sticky admin sessions. `begin` hits A, the paste `complete` hits B → `no_pending_login`. The operator retries and gets the same outcome half the time. Codex OAuth state is in Postgres and is unaffected.
- **Fix:** document sticky routing for `/admin/accounts/*/claude/*`, or forward `complete` to the owning replica. A subprocess cannot move, so at minimum return a specific code (`login_on_other_replica`) and record the owner replica id.
- **Test:** none until the design is chosen. Unit: the error code when the pending login is absent but a DB marker exists.

### 03.16 low (`unverified`) — Gemini OpenAI-compat error bodies wrapped in an array read as "no facts"
- **Where:** `apps/api/src/providers/drivers/gemini.ts:103-114`; `failure/error-body.ts:247-248`.
- **Defect:** `readGeminiFacts`/`readErrorFacts` accept only an object envelope. Google's `/v1beta/openai` surface has been observed to return `[{"error":{code,message,status}}]`.
- **Failure scenario:** if so, `400 [{"error":{"message":"API key not valid…","status":"INVALID_ARGUMENT"}}]` → no facts → `invalid-request`. The bad key is never parked and every request routed to it fails non-retryably. `BILLING_STOPPED` / `RESOURCE_EXHAUSTED` are missed the same way.
- **Fix:** in `readGeminiFacts`, unwrap a one-element array before parsing. Capture a real body for the fixture first.
- **Test:** unit `failure-vendors.test.ts`: array-wrapped invalid-key body → `auth`.

### 03.17 low (`unverified`) — Client tool names lose 13 characters of headroom under the MCP prefix
- **Where:** `claude-sdk/tools/names.ts` (`mcp__client__` prefix); `tools/register.ts:78-87`.
- **Defect:** a client tool name valid on Anthropic's API (`^[a-zA-Z0-9_-]{1,64}$`) becomes `mcp__client__<name>`. A name longer than 51 characters exceeds 64 once qualified. Whether the CLI truncates, hashes, or 400s is unverified.
- **Failure scenario:** an agent framework with long namespaced tool names → upstream 400 → `invalid-request` on a subscription only, while the same request works on `anthropic-api`.
- **Fix:** measure against the stubbed CLI contract. If rejected, map long names to a short stable alias in `names.ts` (hash suffix) and reverse it in `unprefixToolName`.
- **Test:** unit `tools.test.ts`: a 60-char name round-trips through qualify/unprefix within 64.

### 03.9 low — Isolation options copied three times and already drifted
- **Where:** `claude-sdk/options.ts:184-224`, `idle-query.ts:176-196`, `test-probe.ts:194-217`.
- **Defect:** same security-bearing literal in three files (CLAUDE.md "same logic twice → lift"); `executable: "bun"` is set only in `options.ts` (its own comment calls autodetect a bug), so idle/probe spawns still autodetect.
- **Failure scenario:** a resolution rung lands on a `cli.js` → dispatch works, model-catalog sweep / gauge / Test-now spawn the wrong runtime and fail; next isolation flag added to one copy is missed in the others.
- **Fix:** one `isolatedOptions({ configDir, cliPath, controller, canUseTool })` in `options.ts`, spread by all three; security gate test asserts all three call sites use it.
- **Test:** existing `tool-gate.test.ts` extended: each of the three launches has identical isolation keys incl. `executable`.

### 03.10 low — Subprocess env strip misses provider-switch and Sentry vars
- **Where:** `apps/api/src/providers/claude-sdk/env.ts:330-344`.
- **Defect:** names-list strip omits `SENTRY_DSN` (a router secret read by `config/env.ts`) and `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` / `AWS_*` / `CLOUD_ML_REGION`.
- **Failure scenario:** operator host sets `CLAUDE_CODE_USE_BEDROCK=1` for unrelated tooling → every subscription subprocess silently routes to Bedrock under host AWS creds instead of the Account's login (cross-tenant credential, the §3 failure). `unverified` that any deployment sets these.
- **Fix:** add `SENTRY_DSN` to names; add `CLAUDE_CODE_USE_` and `AWS_` prefixes (or flip to an allowlist of inherited vars: `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`, …).
- **Test:** unit `env` gate test — those names absent from `subprocessEnv` output.

## Steps
1. 03.1 `quota.ts` expiry-aware `snapshotOf(state, mode, now)`; update callers (`ingest`, `ingestGauge`, `snapshot` take `now`).
2. 03.2 terminate hook through `render/stream.ts` + `respond.ts` + `invoker.ts`.
3. 03.3 per-attempt slot capture in `invoker.ts`.
4. 03.4 `rate-limit/body-reset.ts` + `compatible-rules.ts` + both compatible drivers.
5. 03.5 coordinate with slice 01 on `attempt.ts`; add `inspectSuccess` to `types.ts`/`driver.ts`/`minimax.ts`.
6. 03.6 → nothing here; slice 02.2 builds it.
6a. 03.11 `request.ts` throw + `failure-rules.ts` phrase; 03.12 `openrouter.ts` rules.
6b. 03.13 hand to slice 02 (`idle-account-probe.ts`); 03.14 one config-dir resolver (`plan.ts`/`catalog/load.ts` with slice 01); 03.15 design note; 03.16/03.17 capture real bodies before coding.
7. 03.7–03.10 small edits.
8. Update `docs/idea/11-anthropic-agent-sdk.md` §5/§9 (bucket expiry, abort on post-byte failure) and `docs/idea/05-routing-and-failover.md` (body-stated reset on compatible drivers) in the same PR.

## Tests
`bun test apps/api/test/unit/claude-sdk/quota.test.ts apps/api/test/unit/claude-sdk/invoker.test.ts apps/api/test/unit/claude-sdk/turn-lifecycle.test.ts apps/api/test/unit/claude-sdk/tool-gate.test.ts apps/api/test/unit/providers/rate-limit.test.ts apps/api/test/unit/providers/failure-vendors.test.ts apps/api/test/unit/providers/model-alias.test.ts apps/api/test/unit/claude-sdk/request.test.ts apps/api/test/unit/claude-sdk/tools.test.ts`
`bunx biome check apps/api/src/providers apps/api/src/services/accounts/refresh`
`bun run typecheck` once.

## Done when
- Stale rejected bucket no longer cools a succeeding account; streaming idle timeout aborts the subprocess and frees its slot within one tick; busy-session retry holds exactly one permit.
- 06.5 body → `rate-limited`, provider-reported reset 2026-10-13T16:00Z; reset-announcing wording never `credits-exhausted`.
- MiniMax 200/1008 → `exhausted`, or the claim is removed from code/docs.
- Malformed Messages body on a Claude sub → 400 with no subprocess spawned.
- OpenRouter moderation 403 → `invalid-request`, no account parked.
- Security gate tests still green (never relaxed).

## Falsified doc claims
- `providers/types.ts:407-411` + `drivers/minimax.ts:13-16`: "classifyFailure accepts a 2xx … MiniMax reports a dead balance in a 200" — never invoked on a 2xx (`attempt.ts:101`).
- `services/accounts/refresh/refresher.ts:25-27`: "a refresh is idempotent" across replicas. Tracked by 02.2.
- `idle-account-probe.ts:79-85` provenance block covers only the Anthropic rows; the `kimi: "k2"` row has none (03.13).
- `claude-sdk/options.ts:94-99` / `invoke.ts:21-22`: "a client that goes away must never orphan a subprocess" / "aborting terminates the subprocess" — post-first-byte failures don't abort (03.2).
- `idle-query.ts:175`: "The same sandbox `options.ts` and `test-probe.ts` build" — `executable` differs.
- `claude-sdk/quota.ts` header: snapshot "the account's whole reading" is treated as current; it is never expired.

## Not covered
- `claude-sdk/session/**` (lineage, store, inflight, cache), `transcripts.ts`, `scrub.ts` regexes, `login/scrape.ts` URL scraping: skimmed only.
- `tools/rewrite.ts` large-input path (`MAX_BUFFERED_TOOL_INPUT` overflow) and `tools/schema.ts` JSON-Schema → Zod fidelity.
- `x-ratelimit-reset` sent as epoch **seconds** (would parse as a ~55-year duration via `parseDurationSeconds`); `anthropic-ratelimit-unified-*-reset` epoch values through `parseInstant` on an `anthropic-compatible` proxy. No pinned vendor is known to send either: `unverified`.
- Operator base URL with a trailing `/v1` on an Anthropic-dialect override → `/v1/v1/messages` (`egress/endpoint.ts` join). Operator error, documented for Ollama only.
- Deleting a Claude account while a turn or a pending login runs: `service.ts:220` `rm -rf`s the dir under the live CLI, and the pending login is not discarded until its TTL. The impact is the deleted account's own request, so it was not deep-dived.
- Cross-area (not deep-dived):
  - `sdk-attempt.ts:180` reads `rateLimit.signal()` when the streaming Response is returned, so later `rate_limit_event`s never reach `applyRateLimit` (slice 01).
  - `egress/headers.ts` forwards client `OpenAI-Organization` / `OpenAI-Project` upstream beside the account's key, letting a router-key holder pick which org the operator's key bills (slice 01, unverified impact).
  - `together.ts` maps every 403 to `invalid-request` (low).
