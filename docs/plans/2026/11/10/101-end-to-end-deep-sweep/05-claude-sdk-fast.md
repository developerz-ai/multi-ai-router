# 05 — Claude subscriptions (Agent SDK + fast transport)

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/providers/claude-sdk/`, `apps/api/src/providers/claude-fast/`, `docs/idea/11-anthropic-agent-sdk.md`, `docs/idea/claude-fast-mode.md`, `docs/research/claude-wire.md`, Claude parts of `docs/idea/07-security.md`.

Fast mode (direct HTTP, default-on) is a sanctioned transport; nothing below objects to its existence. Measurements were taken with throwaway scripts in the session scratchpad against the real modules (no repo file touched, no provider contacted).

## Findings

### 05.1 high — First request across a token-refresh window blocks on its own refresh claim for `CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS` (20 s default)
- **Kind:** bug
- **Where:** `apps/api/src/providers/claude-sdk/invoker.ts:157` + `:171` (and retry `:317` + `:325`); `apps/api/src/providers/claude-sdk/credential-freshness.ts:257-258`, `:350-375`
- **Defect:** invoker calls `ensureFresh` twice per turn (before slot, again on grant); the second call sees the first call's own unreleased holder as an ACTIVE foreign owner and waits the full cap, then proceeds on a no-op claim.
- **Failure scenario:** access token within `CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS` (300 s) of expiry, no refresh yet. Request 1: `claim` owns window → slot granted → recheck `tryOwn` returns `null` (own holder active) → polls every 250 ms; nothing can refresh because nothing spawned → at 20 s logs `claude credential refresh did not land; proceeding anyway` and spawns. Confirmed: real `createSdkInvoker` + real `createCredentialFreshness`, token expiring in 60 s, `maxWaitMs: 1500` → `runQuery` called 1527 ms after entry, warn emitted. With fast mode on, every request inside the CLI's 5-min lead falls back to this path (`claude-fast/invoker.ts:53-59`), and every concurrent request on that account queues behind the same holder. Net: ~20 s added TTFT per account per access-token expiry (~8 h), plus a false "refresh did not land" warn. Introduced by #332 (CHANGELOG "re-asked once the slot is granted").
- **Fix:** make the recheck re-entrant. Either `ensureFresh(accountId, signal, held?: CredentialRefreshClaim)` returning `held` unchanged when its holder is still recorded and unreleased, or a dedicated `recheck(claim)`; holder identity must be carried on the claim (today `Holder` is anonymous). Apply at `invoker.ts:171` and `:325`. `test-probe-preparation.ts:50` takes one claim only and is unaffected — leave it. Update `docs/idea/11-anthropic-agent-sdk.md` §3 ledger.
- **Test:** unit, `apps/api/test/unit/claude-sdk/invoker.test.ts`: real gate, injected reader with expiry inside skew, step-controlled `sleep`; assert `runQuery` runs with zero sleeps consumed and no warn. Second case: token crosses the lead while queued → still exactly one owner.

### 05.2 high — Fast transport spawns two processes per request for the credential read (2.9 ms p50 / 5.3 ms p90 / 13.6 ms max before the upstream call)
- **Kind:** perf
- **Where:** `apps/api/src/composition/request-services.ts:119-122` (composition, slice 01/04 owns the file); `apps/api/src/providers/claude-sdk/account-ownership.ts:123-182`; `apps/api/src/providers/claude-fast/credential.ts:24-44`
- **Defect:** every fast request calls `ownership.withMetadataOwner(...)`, which spawns the `config-owner hold` guardian plus `/bin/cat`, runs a 4-step ready/prepare/activate/started handshake, reads two files, then waits for both exits before returning.
- **Failure scenario:** measured locally with the built `native/config-owner` on a scratch root, 30 sequential reads: owned read 2.9 / 5.3 / 13.6 ms (p50/p90/max) vs 0.06 ms for the bare `readFastCredential`; 8 parallel reads took 17.6 ms total. That is all added time-to-first-token on the default Claude path, against a <5 ms p99 / zero-added-TTFT budget (non-negotiable 8; the labeled exception names the Agent-SDK path, not this one). Also 2 fork/execs per request at pool concurrency.
- **Fix:** keep the fence, stop paying it per request. Cache the last `FastCredential` per account in the fast invoker, keyed by `.credentials.json` `(mtimeNs, size, ino)`; per request do one `stat` and re-read under `withMetadataOwner` only when the key changed or the cached `expiresAt` is inside the lead. Invalidate on account delete/revoke (`AccountCliOwnership.revokeDeletedAccount`) and on any non-2xx auth answer. Token stays in process memory only, never logged. Update `docs/idea/claude-fast-mode.md` § Authentication and fallback ("no caching stale rotated credentials" → the stat-keyed rule).
- **Test:** unit `apps/api/test/unit/claude-fast/invoker.test.ts`: N warm requests → `credential` reader called once; file rewritten → re-read; account revoked → next request refused with `UpstreamAdmissionRefused`, zero reads. Add a `bin/bench` leg for a fast-mode stub upstream (none exists; `claude-fast-mode.md:77-78` says the benchmark "is still required").

### 05.3 medium — `USAGE_REPORT_DISCORD_WEBHOOK_URL` (and any unlisted host secret) is inherited by every `claude` subprocess
- **Kind:** nn-violation (defence-in-depth half of non-negotiable 2/3; no exfiltration path exists while the allowlist holds)
- **Where:** `apps/api/src/providers/claude-sdk/env.ts:35-61`; `apps/api/src/config/usage-report.ts:97`
- **Defect:** the strip list claims to be "every secret-bearing name the env schema reads" but omits the Discord webhook URL, which `docs/idea/07-security.md:151` itself calls a credential; `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` are listed but no longer exist in the schema.
- **Failure scenario:** router started with `USAGE_REPORT_DISCORD_WEBHOOK_URL` set → present in `Options.env` of dispatch, probe, idle query and login spawns. Same for operator-level `PGPASSWORD`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `HTTPS_PROXY` with userinfo, `NODE_OPTIONS`: the list is a denylist and passes them.
- **Fix:** add the webhook name; drop the two dead names. Then make drift impossible: export the secret-bearing field names from `apps/api/src/config/` (slice 01 owns) and have the security gate assert each is stripped. Consider flipping `subprocessEnv` to an allowlist (`PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `TMPDIR`, `SSL_CERT_*`, `NODE_EXTRA_CA_CERTS`, proxy vars) — decision for the owner; document in `docs/idea/07-security.md#subprocess-isolation`.
- **Test:** extend `apps/api/test/integration/claude-sdk-security.test.ts` "subprocessEnv strips…" with the webhook name and a schema-derived loop.

### 05.4 medium — SDK stream pacing, deny-hold and login/auth-status timeouts are constants no config can reach
- **Kind:** nn-violation (non-negotiable 11)
- **Where:** `apps/api/src/providers/claude-sdk/render/idle-guard.ts:47` (`idleMs: 90_000, heartbeatMs: 15_000`), `:87`; `tools/early-stop.ts:53` (60 s); `login/spawn.ts:72`, `:75` (30 s / 60 s); `login/status.ts:27`, `:33` (15 s / 1 s); `apps/api/src/composition/request-services.ts:88-100` passes no `pacing`; `services/accounts/connect/fromEnv.ts:105-108` passes no timeouts
- **Defect:** `SdkInvokerDeps.pacing` and the login options exist as seams ("so the composition root can widen either from config") but nothing wires them; no env field exists.
- **Failure scenario:** operator sets `SERVER_IDLE_TIMEOUT_SECONDS` below 15 → listener closes every quiet SDK stream before the first `: ping` (the 2026-09-07 failure the idle-guard comment records), with no knob to shorten the heartbeat. A model with a >90 s tool-free thinking gap is failed `504` with no knob either.
- **Fix:** add `CLAUDE_SDK_STREAM_IDLE_SECONDS`, `CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS`, `CLAUDE_SDK_DENY_HOLD_SECONDS`, `CLAUDE_LOGIN_URL_TIMEOUT_SECONDS`, `CLAUDE_LOGIN_EXCHANGE_TIMEOUT_SECONDS`, `CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS` (config: slice 01), defaults = today's values, boot check heartbeat < server idle timeout. Thread `holdTimeoutSeconds` through `createPassthrough`. Document in `docs/idea/11-anthropic-agent-sdk.md` §6/§9.
- **Test:** unit env-validation (heartbeat ≥ server idle → boot error); invoker test asserting injected pacing reaches `renderSdkResponse`.

### 05.5 medium — Busy-session retry: the first attempt's late epilogue releases the retry's refresh claims
- **Kind:** bug
- **Where:** `apps/api/src/providers/claude-sdk/invoker.ts:177-180`, `:226-230`, `:315-325`; `turn-lifecycle.ts:108-121`
- **Defect:** `releaseClaims` closes over the `let` bindings `claim` / `rechecked`; attempt 1's `onEnd` runs asynchronously (after `inner.return()`), by which time the retry has reassigned both, so it releases the retry's claims. Residual of prior 03.3 (101-deep-bug-sweep), which fixed only the slot by passing `ownSlot`.
- **Failure scenario:** resume plan, CLI answers busy-session, token inside the refresh window. Outer catch releases old claims, takes new ones, starts attempt 2; attempt 1's epilogue then fires `onEnd` → new owner claim released while attempt 2's CLI is mid-refresh → a second caller is admitted as owner: the two-refresher race the gate exists to prevent.
- **Fix:** pass the claims into `attempt` beside `ownSlot` (one `release` closure per attempt, built from the values, not the bindings). Fold into the 05.1 change.
- **Test:** unit `invoker.test.ts`: `runQuery` fake whose first iterator throws busy-session and whose `return()` resolves late; assert the retry's claim is still held (a second `ensureFresh` waits) until the retry's stream ends.

### 05.6 medium — Fast transport: synchronous body work scales with history (4.5 ms at 850 KB, 12.5 ms at 3 MB) and three of the passes are avoidable
- **Kind:** perf
- **Where:** `apps/api/src/providers/claude-fast/request.ts:26-36` (parse + zod over every block), `:87` (`JSON.stringify` of the whole history for `promptId`), `:115-121` (per-block shallow copies), `:161` (`hasCacheControl` deep walk); `integrity.ts:34` and `:40` (two full `JSON.stringify`)
- **Defect:** one request serializes the conversation three times, walks it once more, and copies every block, all on the event loop before the upstream call.
- **Failure scenario:** measured: 850 KB / 302 messages → `readFastRequest` 1.9 ms + `prepareFastRequest` 2.6 ms; 3.1 MB / 602 messages → 5.0 + 7.5 ms. Long Claude Code histories are the normal shape; every other in-flight stream stalls for that long.
- **Fix:** (a) derive the generic `promptId` from a running hash of message hashes or from `sessionKey + prompts` index instead of stringifying the history; (b) in `stampIntegrity`, serialize `messages`/`tools` once and assemble projection and final body by string concatenation around the two differing fields (model, billing text) — keep the 22/22 + 15/15 capture tests as the oracle; (c) stop `hasCacheControl` at the first hit per branch and skip it when the raw text has no `"cache_control"` substring; (d) copy only the last message (the one mutated). Record in `docs/research/claude-wire.md` that the projection byte layout is unchanged.
- **Test:** existing `apps/api/test/unit/claude-fast/request.test.ts` + packaging fixtures must stay byte-identical; add a micro-bench assertion in `bin/bench` leg from 05.2.

### 05.7 medium — Fast transport swallows every non-abort failure into one unlogged sentence
- **Kind:** bug
- **Where:** `apps/api/src/providers/claude-fast/invoker.ts:134-142`
- **Defect:** the catch replaces any error (DNS, TLS, reset, `stampIntegrity` "uncalibrated Claude request profile" / "missing Claude request checksum", a zod throw in `prepareFastRequest`) with `new Error("Claude direct HTTP request failed")`, no `cause`, no log, no class.
- **Failure scenario:** a calibration bug in `prepareFastRequest` throws on every request → every account answers `unknown 502`, the chain fails over across the whole pool, and the only trace is "the Claude Agent SDK failed for a reason this router does not recognize". Nothing distinguishes it from a network blip.
- **Fix:** split the try: preparation errors → SDK fallback with reason `"profile"` (the documented pre-inference fallback) plus one warn; transport errors → typed `UpstreamTransportError` (`RouterError` family, slice 04) carrying `cause`, with the scrubbed message handed to the attempt log through the same side channel `fastFailureOf` uses. Never include header values.
- **Test:** unit `invoker.test.ts`: `prepareFastRequest` throw → SDK invoked once, no HTTP; fetch rejecting `ECONNRESET` → classified retryable server error with a logged reason and no token in it.

### 05.8 medium (`unverified`) — A turn's slot and refresh claim have no exit if the SDK iterator's `return()` never settles
- **Kind:** bug
- **Where:** `apps/api/src/providers/claude-sdk/turn-lifecycle.ts:108-121`; `idle-query.ts:155-165`
- **Defect:** `onEnd` (slot + claims + abort-bridge detach) runs only after `await inner.return?.()`; nothing bounds that await and the controller is not aborted on the success path.
- **Failure scenario:** CLI subprocess ignores stdin EOF after `result` (hung MCP teardown, stuck write) → `return()` pends → the account's per-account permit is gone for the process lifetime; four such turns wedge the account (`concurrency.ts` "a leaked permit is invisible until the fourth one"). Not reproduced — depends on SDK `return()` semantics.
- **Fix:** race `inner.return()` against a configured bound (reuse the gauge timeout or a new `CLAUDE_SDK_TEARDOWN_TIMEOUT_MS`); on expiry call the launch's `abort()` and run `onEnd`. Same in `openIdleQuery.close`.
- **Test:** unit `turn-lifecycle.test.ts`: source whose `return()` never resolves → `onEnd` fires after the injected bound, abort called once.

### 05.9 medium — No gate enumerates `query()` call sites; a fourth site can skip `isolatedOptions` without failing the build
- **Kind:** test-gap
- **Where:** `apps/api/test/integration/claude-sdk-security.test.ts:247` ("one of three call sites"); call sites `invoker.ts:129`, `test-probe.ts:158`, `idle-query.ts:119`
- **Defect:** the security gate asserts the options of the two launches it builds (dispatch, probe) and the unit tests cover the idle query, but nothing fails when new code imports `query` from `@anthropic-ai/claude-agent-sdk` elsewhere or builds `Options` without `isolatedOptions`.
- **Failure scenario:** a new keepalive/diagnostic helper calls `query({ prompt, options: { model } })` → built-ins reachable on the host, host `CLAUDE.md` loaded; all existing gates stay green.
- **Fix:** add a source-scan test: the only files importing the value `query` from the SDK are those three; each references `isolatedOptions` or `createQueryLaunch`; no file under `apps/api/src` passes `bypassPermissions`, `allowDangerouslySkipPermissions`, or a non-empty `tools`. Move the idle-query isolation assertions into the integration gate file so "the gate" is one file.
- **Test:** the scan itself, in `claude-sdk-security.test.ts`.

### 05.10 low — Every SDK chunk is zod-parsed 3–5 times
- **Kind:** perf
- **Where:** `apps/api/src/providers/claude-sdk/render/stream.ts:180-187`; `render/events.ts:229-232`; `tools/early-stop.ts:180-182`
- **Defect:** `handle` runs `readSdkMessage`, then `isLivenessOnly` runs `readWireEvent`, then the `stream_event` branch runs `readWireEvent` again; with tools declared `early-stop.step` has already run both.
- **Failure scenario:** tool-using streaming turn at ~50 chunks/s → ~250 `safeParse` + per-chunk `setTimeout`/`clearTimeout` from `openWindow`; pure allocation churn on the SDK path.
- **Fix:** parse once per message into a small view `{ message, event }` in `early-stop`/`stream` and pass it down; `isLivenessOnly(view)` reads the parsed event. Keep one idle timer per window and re-arm by timestamp instead of create/cancel per message.
- **Test:** existing `render.test.ts` / `tool-gate.test.ts` unchanged; add a counter test that `readWireEvent` runs once per chunk.

### 05.11 low — Fast-mode quota readings are labelled `threshold-triggered`
- **Kind:** bug
- **Where:** `apps/api/src/providers/claude-sdk/quota.ts:102-115`; `apps/api/src/providers/claude-fast/quota.ts:13-23`
- **Defect:** `ingest` treats any reading carrying `utilization` as an alarm; fast mode reports utilization from response headers on every request, so its continuous gauge is stored with the alarm source.
- **Failure scenario:** console shows the window's utilization source as threshold-triggered for a value refreshed every request; a later reading without the header drops to `undefined` instead of keeping the last continuous value.
- **Fix:** let `reportFastQuota` mark its readings (`source: "continuous"`) and have `ingest` honour it; `docs/idea/11-anthropic-agent-sdk.md` §5.
- **Test:** unit `quota.test.ts`: header-shaped reading → `utilizationSource: "continuous"`, retained across a reading without utilization.

### 05.12 low — A permanent fast-mode fallback is visible only at `debug`
- **Kind:** bug
- **Where:** `apps/api/src/composition/request-services.ts:133-137`; `apps/api/src/providers/claude-fast/credential.ts:13-16`
- **Defect:** an account whose `.claude.json` lacks `userID` / `oauthAccount.accountUuid` (or an unresolved alias) falls back to the SDK on every request, logged at debug with no account id and no metric.
- **Failure scenario:** one account in a pool silently serves every request through a 245 MB subprocess and fresh-session replay; operator sees only higher latency.
- **Fix:** `onFallback(reason, accountId)`; count in a `claude_fast_fallback_total{reason}` metric and warn once per account per reason (observability: slice owning `docs/idea/08-observability.md`).
- **Test:** unit: two fallbacks for one account → one warn, counter 2.

### 05.13 low — Structure: four files over 300 LOC, duplicated helpers, providers importing from `services/`
- **Kind:** structure
- **Where:** `claude-sdk/credential-freshness.ts` (422), `invoker.ts` (347), `render/envelope.ts` (316), `tools/early-stop.ts` (311). Abort bridge written three times (`options.ts:128-134`, `idle-query.ts:147-150`, `test-probe.ts:176-179`). `resolveCli` default closure ×4 (`invoker.ts:131`, `test-probe.ts:159-161`, `usage-gauge-probe.ts:65-67`, `model-list.ts:103-105`). `abortReason`/`throwIfAborted` ×2 (`concurrency.ts:185-199`, `credential-freshness.ts:406-416`). UUID regex ×2 (`config-dir.ts:57`, `transcripts.ts:47`), `isMissing` ×2 (`config-dir.ts:215`, `transcripts.ts:251`), `isRecord` ×7. Upward imports: `claude-fast/invoker.ts:1-2` (`services/dataplane/sdk-attempt-response`, `types`), `claude-fast/response.ts:2-3`, `claude-fast/tool-choice.ts:1`, `claude-sdk/request.ts:3-6`, `claude-sdk/tools/register.ts:7`; trailing import at `claude-fast/invoker.ts:146`; generic `Error` at `invoker.ts:138`.
- **Defect:** layer direction stated in `session/conversation.ts:11-12` ("`services/dataplane` imports `providers`, never the other way") is broken in five places; shared logic drifts.
- **Failure scenario:** maintenance only.
- **Fix:** move `releasingWith`, SSE parser and error-body helpers used by providers into a provider-level shared module (coordinate with slices 03/04/06); extract `bridgeAbort(signal)`, `defaultCliResolver(override)`, one `abort.ts`; split `credential-freshness.ts` (holders/lease vs classify) and `invoker.ts` (claim/slot acquisition vs attempt).
- **Test:** none new; existing suites.

### 05.14 low — Request-attributable "Extra Usage gated" refusal cools the account (prior decision, flagged)
- **Kind:** bug (`unverified` for the routing effect — slice 03 owns it)
- **Where:** `apps/api/src/providers/claude-sdk/failure-rules-quota.ts` (`claude-sdk:extra-usage-gated`, `rate-limited` 429); decision recorded `docs/idea/11-anthropic-agent-sdk.md:1252`; cause described in `scrub.ts:17-26` as failing "identically on every account in the pool"
- **Defect:** a refusal caused by one client's unscrubbed harness prompt is classified as account capacity, so the chain cools each account it tries.
- **Failure scenario:** a harness rewords its preamble (the blast radius `scrub.ts` names) → one key holder's requests walk the pool, each account marked rate-limited → other tenants see `429` until the cooldowns lapse.
- **Fix:** keep the classification for the log, but stop it striking the account when the same request has produced the same signal on ≥2 accounts in one chain (request-scoped wall, `error.router` `wall: "request"`). Needs owner ruling since §9's table chose "cool and fail over".
- **Test:** integration (mocked SDK): two accounts both answer the phrase → client gets a request-scoped error, neither account is `cooling_down`.

## Checked, not a bug
- All three `query()` sites build from `isolatedOptions` (`options.ts:186-225`): `settingSources: []`, `strictMcpConfig`, `skills: []`, `tools: []`, frozen empty `PERMITTED_TOOLS`, `permissionMode: "dontAsk"`, deny-by-default `canUseTool`, neutral `cwd`, `ANTHROPIC_*` prefix strip, forced `QUERY_ENV_OVERRIDES`. Dispatch adds only client-tool MCP declarations whose handler refuses and a `PreToolUse` hook that denies (`tools/passthrough.ts:81-93`, `tools/early-stop.ts:168-177`). No internal-MCP execution, no `bypassPermissions`.
- Security gate exists and is live: `apps/api/test/integration/claude-sdk-security.test.ts` (host tools denied on the dispatch launch, the probe launch, and the launch the production invoker builds); idle query covered in `test/unit/claude-sdk/idle-query.test.ts:299+` and `model-list.test.ts:259+`. No `.skip`/`.todo`/`.only` in any Claude test file.
- Fast credential fence: `request-services.ts:119-122` refuses a `configDir` that is not `pathFor(accountId)` before any read; `credential.ts` reads only `<configDir>/.credentials.json` + `.claude.json`, never the refresh token, never HOME; errors return `null` with no path/content. Token passed to `sanitizeFastError` as a secret to redact (`invoker.ts:110`).
- Upstream response headers do not reach clients: `services/dataplane/egress/headers.ts:35` allowlists (`anthropic-organization-id`, unified rate-limit headers stay inside).
- Fast mode on → session store deliberately not wired (`request-services.ts:204`), so no lineage parse/hash per request; SDK fallback turns run fresh by design (`claude-fast-mode.md` § Histories).
- `CLAUDE_FAST_MODE=false` → `fastInvoker` undefined → `invokeSdk` used directly (`request-services.ts:102-115`, `:201`). Model passes through; `[1m]` becomes a beta header, alias only via live catalog (`:123-131`).
- Fast transport holds an SDK concurrency slot: documented ("existing global/per-account concurrency bounds still apply").
- Session cache/alias scoping by router key and account (`session/fingerprint.ts:43-52`, `session/bound.ts:38-46`); prior 102/05.1 fixed.
- `config-dir.ts:137-144` rejects non-UUID ids before any path join; symlink-refusing provision/carry/sweep (`config-dir-fs.ts`, `session-carry.ts:168-212`, `transcripts.ts`).
- Client disconnect on a stream: `respond.ts:82-86` → `terminate` → prompt released + `abort` → subprocess killed, then epilogue frees slot. Non-stream abort propagates through the bridge (`options.ts:128-134`).
- `usage-gauge.ts` `startedAt` / `reportedUnavailable` grow per account id only; bounded by accounts ever created.
- `envelope.mergeUsage` newest-wins across internal turns is only the fallback when no `result` usage exists (early stop = one turn).
- Streaming forced `tool_choice` unchecked on both transports: documented v1 scope (`11-anthropic-agent-sdk.md` §7 item 9, `claude-fast-mode.md` § Forced tool choice).

## Doc claims falsified
- `docs/idea/11-anthropic-agent-sdk.md:4` says "Opt-in fast mode"; `apps/api/src/config/env-reader.ts:144` defaults `CLAUDE_FAST_MODE` to `true`. Same wording at `CLAUDE.md:146`, `CLAUDE.md:170`, and `apps/api/src/providers/claude-sdk/invoke.ts:30`.
- `apps/api/src/providers/claude-sdk/env.ts:48-50` says the strip list is every secret-bearing env name; `USAGE_REPORT_DISCORD_WEBHOOK_URL` (called a credential at `docs/idea/07-security.md:151`) is absent.
- `render/idle-guard.ts:38-39` says pacing is "Injected at every call site so the composition root can widen either from config"; `composition/request-services.ts:88-100` injects none and no env field exists.
- `invoker.ts:33-35` / `request.ts:11-18` / `session/conversation.ts:22` each claim the body is parsed once on the SDK path; with a session store wired (fast mode off) `sdk-attempt.ts:218` → `readConversation` and `invoker.ts:148` → `readSdkRequest` both decode + `JSON.parse` it per attempt (measured 5.8 ms + 2.2 ms at 850 KB).
- `idle-query.ts:60` and `model-list.ts:64` say the config dir is "also the subprocess's working directory"; `options.ts:209` uses the neutral workspace since #296.
- `claude-fast-mode.md:13` "Credentials are read after concurrency admission" — true, but the doc omits that the read is a per-request process spawn (05.2).

## Steps
1. 05.1 + 05.5 together: re-entrant recheck and per-attempt claim release in `invoker.ts` / `credential-freshness.ts`; tests first.
2. 05.3: env strip names + schema-derived gate assertion; 05.9: call-site scan in the same gate file.
3. 05.2: stat-keyed fast credential cache with delete/revoke invalidation; bench leg.
4. 05.7: split fast invoker preparation vs transport errors; typed error + log.
5. 05.6: single-pass integrity stamp and promptId hash; keep capture fixtures byte-identical.
6. 05.4: env fields + wiring for pacing, deny-hold, login/auth-status timeouts.
7. 05.8: bounded teardown in `turn-lifecycle.ts` and `idle-query.ts`.
8. 05.10–05.13: parse-once view, quota source label, fallback visibility, structure cleanup.
9. 05.14: owner ruling, then implement with slice 03.
10. Docs: `11-anthropic-agent-sdk.md` (§3, §5, §6, §9, line 4), `claude-fast-mode.md`, `07-security.md`, `CLAUDE.md` "opt-in" wording, `CHANGELOG.md`, version.

## Tests
- Extend: `apps/api/test/unit/claude-sdk/invoker.test.ts`, `credential-freshness.test.ts`, `turn-lifecycle.test.ts`, `quota.test.ts`, `render.test.ts`; `apps/api/test/unit/claude-fast/invoker.test.ts`, `request.test.ts`; `apps/api/test/integration/claude-sdk-security.test.ts`, `claude-fast-response.test.ts`.
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end.

## Done when
- A turn starting inside the refresh window spawns with no wait and no "did not land" warn; busy-session retry keeps its claim until its own stream ends.
- Warm fast requests perform zero process spawns; credential re-read only on file change; `bin/bench` fast leg within budget.
- Security gate fails on an unstripped schema secret and on any new unisolated `query()` importer.
- Fast-transport failures carry a class and a logged, redacted cause; preparation failures fall back to the SDK.
- Every interval in 05.4 is an env field with the current value as default.
- Docs above no longer say "opt-in" and match the strip list and pacing wiring.

## Not covered
- `resolve-cli.ts`, `cli-probe.ts`, `reasoning.ts`, `driver.ts`, `test-probe-result.ts`, `login/contract.ts`, `print-cli-path.ts`: skimmed by signature/grep only, not read line by line.
- `native/config-owner.c` (the guardian helper): timed, not audited.
- `docs/research/claude-wire.md` and most of `11-anthropic-agent-sdk.md` (1361 lines): only the sections grepped for the claims above.
- Agent SDK internals: whether `Query.return()` can hang (05.8) and what managed/enterprise policy files the CLI loads regardless of `settingSources: []` — not verified against SDK source.
- What routing does with a fast-transport `401` (park `needs_reauth` vs one SDK confirmation turn) and with `rate-limited` lacking a reset (05.14): slice 03's code, not traced.
- Fast streaming has no upstream idle guard of its own (only the attempt deadline); whether the shared relay adds one was not checked.
- Header value units for `anthropic-ratelimit-unified-*-utilization` (fraction vs percent) not verified against a capture.
- No full test suite run; only the two timing scripts and one reproduction script described above.
