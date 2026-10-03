# 05 — Claude SDK

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/providers/claude-sdk/`, `apps/api/test/unit/claude-sdk/`, SDK-specific unit tests under `apps/api/test/unit/providers/`, and `apps/api/test/integration/claude-sdk*.test.ts`. Documentation edits coordinated through the overview.

## Findings

### 05.1 high — Fingerprint aliases allow one router key to resume another key's SDK session
- **Where:** `apps/api/src/providers/claude-sdk/session/store.ts:191`, `:229`, `:256`; `apps/api/src/providers/claude-sdk/session/fingerprint.ts:46`.
- **Defect:** Direct session keys are scoped by `apiKeyId`, but fallback fingerprint aliases are scoped only by Account and opening user text; alias resolution never verifies the owning router key.
- **Failure scenario:** Key A and key B can use the same pooled subscription Account. A sends a first user message `hello`, then remembers `victim-sdk-session`. B supplies its own distinct explicit session header and a transcript beginning `hello`, followed by an invented assistant answer and another user message. B's direct cache lookup misses; the shared fingerprint finds A's session; stored input-prefix hashes match the opening message. B receives a resume plan for A's server-side transcript, bypassing router-key isolation. The in-flight claim also uses the distinct direct key, so it does not protect this alias collision.
- **Proof:** Pure `createSessionStore` call with existing `memorySessions()` fixture, distinct `apiKeyId` and `sessionKey`, one shared Account, no database/provider/model call → attacker plan `{ kind: "resume", sdkSessionId: "victim-sdk-session", lineage: "continuation", deltaFrom: 1 }`. This proves cross-key session selection; no production transcript was accessed.
- **Fix:** Scope every alias insertion, lookup, eviction and associated claim by router-key identity in addition to Account. Carry/verify ownership explicitly at the alias boundary; a direct cache miss must never authorize an alias belonging to another key. Include alias-key schema changes in cache invalidation/deployment handling. Preserve same-key legitimate alias continuity and Account isolation.
- **Test:** Failure first in `session-store.test.ts`: reproduce the two-key sequence above and require B to receive `fresh/no-session`, never A's SDK id. Cover explicit-header and headerless callers, concurrent requests, different Accounts, and legitimate same-key continuity. Test `resolve()`, not just `binding()`; the existing two-key test at `session-store.test.ts:102` exercises only the safe direct lookup.

### 05.2 high — A message-start frame hides a later failed SDK result behind HTTP 200
- **Where:** `apps/api/src/providers/claude-sdk/render/stream.ts:258`; `apps/api/src/providers/claude-sdk/render/envelope.ts:246`.
- **Defect:** Failed SDK results are raised only before `envelope.started`; a metadata-only `message_start` makes a later authenticated failure look like a successful empty completion.
- **Failure scenario:** SDK emits `message_start` with empty content, then `result` carrying `is_error: true`, `terminal_reason: "api_error"`, and an authentication failure. Non-streaming caller receives HTTP 200 with `content: []` and `stop_reason: null`. Streaming caller receives a normal terminal sequence after a failed turn. The failover/health layer therefore does not receive the real failure.
- **Proof:** Pure `renderSdkResponse` with a two-message async generator produced status 200 and empty content for this failed result.
- **Fix:** Track failed-result state independently of whether a start frame was synthesized/emitted. Non-streaming rendering has sent no client bytes: propagate the classified failure before constructing its response. Once streaming bytes exist, emit a terminal error frame and never a success terminator or retry. Retain narrowly justified successful client-tool early-stop behavior; a synthetic successful tool result is distinguishable from an actual failed SDK result.
- **Test:** Failure first in `result-error.test.ts`: start-only → auth-error result, both stream modes. Add closed text block → actual failed result, and preserve the existing successful early-stop tool-call tests. Replace the broad expectation that every failed result after content is HTTP 200 with explicit supported semantics.

### 05.3 medium — Native Anthropic server tools are silently converted into client tools
- **Where:** `apps/api/src/providers/claude-sdk/request.ts:113`; `apps/api/src/providers/claude-sdk/tools/register.ts:61`, `:166`.
- **Defect:** The same-dialect SDK request path does not apply the documented unsupported-server-tool rejection; the loose tool schema accepts native tool types and registration treats them as client functions.
- **Failure scenario:** `/v1/messages` addressed to a subscription Account includes `tools: [{ type: "web_search_20250305", name: "web_search" }]`. `readSdkRequest` accepts the declaration; registration invents an empty client-function schema for a tool the caller expected Anthropic to execute server-side. Request is billed/dispatched instead of the documented field-specific 400.
- **Proof:** Pure `readSdkRequest` returned the declaration unchanged in `tools`. The accepted tool is subsequently passed directly to `createPassthrough`; same-dialect SDK egress has no translation pair to reject it.
- **Fix:** Validate the supported SDK tool surface at the SDK boundary before acquiring a subprocess slot. Reject native server/tool variants with a stable client 400 naming `tools[index].type`. Continue permitting ordinary client-declared tools and retain all host-execution denial gates. Do not solve this by enabling any host or SDK built-in tool.
- **Test:** Failure first in `request.test.ts` and stubbed invoker integration: web-search/server-tool and computer-tool declarations return 400; `runQuery` was not called and no slot remains held. Valid function tools still reach passthrough registration. The existing host-tool denial security gate remains enabled.

## Documentation claims falsified
- `docs/idea/11-anthropic-agent-sdk.md:568` and surrounding session-store contract describe safe session reuse; alias ownership does not match direct-key isolation. Update the alias scope explicitly, and `docs/idea/07-security.md` alongside it.
- `docs/idea/11-anthropic-agent-sdk.md:114`, `:826` and `docs/idea/06-protocol-translation.md:272` promise a field-specific 400 for SDK server tools; current same-dialect SDK code does not enforce it.
- SDK failed-result documentation must distinguish response frames in memory from bytes already delivered; a non-streaming fold has not sent client content.

## Steps
1. Add and fix the cross-key alias regression first; audit alias reads/writes and claims together.
2. Add the failed-result rendering regressions, then fix termination behavior without stream buffering.
3. Add SDK tool-boundary validation and no-spawn assertions.
4. Coordinate spec updates in `docs/idea/11-anthropic-agent-sdk.md`, `docs/idea/07-security.md`, and `docs/idea/06-protocol-translation.md`.

## Tests
- Baseline combined unit run: **1,111 pass, 0 fail**; [`04-06-unit-tests.log`](04-06-unit-tests.log).
- `bin/test apps/api/test/unit/claude-sdk/session-store.test.ts apps/api/test/unit/claude-sdk/result-error.test.ts apps/api/test/unit/claude-sdk/request.test.ts apps/api/test/unit/claude-sdk/invoker.test.ts apps/api/test/unit/claude-sdk/tool-gate.test.ts`.
- With the coordinator's test database, run relevant SDK integration tests including the mandatory `claude-sdk-security.test.ts`; SDK `query()` remains stubbed. `bunx biome check <changed files>`. Coordinator runs typecheck and full gate once.

## Done when
- Different router keys cannot resolve the same SDK session through an alias; same-key continuation still works.
- Failed SDK results yield an honest failure in both response modes; no retry follows emitted streaming bytes.
- Unsupported native server tools fail before dispatch; explicit empty host-tool allowlist and `settingSources: []` remain enforced.

## Coverage and limits
- Read launch isolation/environment, request/prompt conversion, tool registration/denial/early stop, rendering, quota readings, freshness/concurrency/idle-query lifecycle, session cache/store/lineage, credential metadata, transcript lifecycle and tests/history.
- Existing issue [#137](https://github.com/developerz-ai/multi-ai-router/issues/137) already tracks refresh-lock collisions. Which proposed race occurred in production remains **unverified**; do not count it as a newly reproduced cause or weaken the current retryable classification.
- No real CLI subprocess, provider request, credential exchange, or production transcript read performed. Source and pure/stubbed tests cannot establish current CLI-internal behavior or full multi-replica safety.
