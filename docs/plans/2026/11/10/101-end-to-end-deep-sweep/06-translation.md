# 06 — Protocol translation

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/translate/**`, `apps/api/test/unit/translate/**`, `docs/idea/06-protocol-translation.md`.

Method: all 65 source files read. Suspicions confirmed with throwaway `bun run` scripts importing the real exports (outputs quoted as "measured" / "confirmed"). No non-negotiable violation found: no model substitution (`model: request.model` in all 6 request translators), no same-dialect touch (registry has no diagonal, `registry.ts:304-307`), no clock/random/store/logger in the directory.

## Findings

### 06.1 high — SSE parser rescans the whole buffered partial line on every chunk (quadratic in line length)
- **Kind:** perf
- **Where:** `apps/api/src/services/translate/sse/parse.ts:97-116`
- **Defect:** `consume` does `buffer += text` then scans from `cursor = 0`, so a line that spans N chunks is re-read N times (plus a rope flatten each time).
- **Failure scenario:** one `data:` line of L bytes arriving in chunks of c bytes costs ~L²/2c char reads, synchronous, on the shared event loop. Measured: 1 MiB line / 16 KiB chunks = 81 ms; 1 MiB / 4 KiB = 637 ms; 4 MiB / 16 KiB = 2.55 s; 8 MiB / 16 KiB = 6.4 s. Real long lines on the translate path: Responses `response.completed` / `output_item.done` / `function_call_arguments.done` (each restates the full arguments or full output; a 500 KB file-write tool call yields three such lines), plus `response.created` / `in_progress` echoing instructions + tools. Every concurrent request stalls for that time; steady state is fine (3.5 µs/frame measured).
- **Fix:** keep a `scanned` offset: after a push with no terminator found, next push starts scanning at the old `buffer.length` (minus nothing — CR/LF are single units). Better: hold partial-line pieces in a `string[]`, search each new chunk with `indexOf("\n")` / `indexOf("\r")`, and join once when the terminator arrives. `pendingLf`, BOM and `flush` behaviour unchanged.
- **Test:** unit, `test/unit/translate/sse-parse.test.ts`: (a) correctness — a 2 MiB single `data:` line fed in 1 KiB chunks yields one frame equal to the input; mixed `\r\n` split across chunks still passes; (b) complexity guard — count char visits through an injected counter or assert time ratio 4 MiB vs 1 MiB < 6× (linear ≈ 4×, today ≈ 30×).

### 06.2 medium — Request parse walks every failing union branch per block; ~4–5 ms per long transcript, repeated per translation shape
- **Kind:** perf
- **Where:** `shared/anthropic.ts:153-163` (9-way `z.union`), `shared/anthropic.ts:100`, `shared/openai-chat.ts:49`, `shared/openai-responses.ts:60-66,105-112`; caller re-translates per shape at `services/dataplane/translate-body.ts:148-173` (shape key includes `sealed.accountId`).
- **Defect:** blocks/items/parts are plain `z.union`s, so a `tool_result` block runs and fails the `text`, `image`, `tool_use` parsers first, and an unknown block type fails eight branches (each building issue arrays) before the catch-all.
- **Failure scenario:** measured per block: `text` 0.30 µs, `tool_result` 1.44 µs, unsupported (`server_tool_use`) 5.82 µs. An 801-message / 1601-block Claude Code transcript: Zod parse 4.3–4.7 ms of a 5.3–5.9 ms translate — the whole <5 ms p99 budget on the cross-dialect path, and it is paid again for every candidate whose shape differs (every account on anthropic→openai-responses under a reasoning seal).
- **Fix:** (1) dispatch on `type` first: `z.discriminatedUnion("type", [...known])` wrapped as `z.union([known, unsupported])`, same for tool-result content, chat parts, Responses parts/items (message item keeps its `type`-optional branch last). Error paths from `parseRequest`'s `locate` (`shared/reject.ts:61-70`) must still name the deepest field — keep the existing 400-path tests green. (2) Split parse from emit: export `parse<Dialect>Request(body)` and let each `*Request` accept the parsed value, so `translate-body.ts` parses once per request and only re-emits per shape (cross-slice: dataplane owns `translate-body.ts`).
- **Test:** unit, `test/unit/translate/request-anthropic-openai.test.ts`: existing malformed-block cases keep their exact `400` field paths (`messages.0.content.1…`); new case — a `tool_use` missing `id` is still "malformed", not "unsupported". Perf guard in `bin/bench` is optional; record before/after in the PR.

### 06.3 medium — `tool_choice: "none"` + `parallel_tool_calls` emits `{type:"none", disable_parallel_tool_use}` toward Anthropic
- **Kind:** bug (`unverified` upstream verdict)
- **Where:** `openai-chat-to-anthropic/request.ts:183-198`, `openai-responses-to-anthropic/request.ts:175-188`
- **Defect:** the parallel policy is spread onto whatever choice was mapped, including `none`, which states no parallel policy in Anthropic's dialect.
- **Failure scenario:** confirmed output for `{tools:[f], tool_choice:"none", parallel_tool_calls:false}`: `{"type":"none","disable_parallel_tool_use":true}`. Anthropic's `none` choice carries `type` only; a strict Messages validator answers `400` on a body the router wrote (agent frameworks set `parallel_tool_calls` globally and switch `tool_choice` to `none` for the final-answer step).
- **Fix:** one shared helper in `shared/tools.ts` (e.g. `anthropicToolPolicy(choice, parallel, hasTools)`) used by both translators: attach `disable_parallel_tool_use` only to `auto` / `any` / `tool`; for `none` return the bare choice. Removes the duplicated inline logic too (see 06.11). Update the `parallel_tool_calls` row at `docs/idea/06-protocol-translation.md:962`.
- **Test:** unit, `test/unit/translate/parallel-and-refusal.test.ts`: failure case first — both ingress dialects with `none` + `parallel_tool_calls:false` → `tool_choice` deep-equals `{type:"none"}`.

### 06.4 medium — Non-streaming tool-call arguments that do not decode become `input: {}` with `stop_reason: "tool_use"`
- **Kind:** bug
- **Where:** `openai-chat-to-anthropic/response.ts:130-140`, `openai-responses-to-anthropic/response.ts:107-117`
- **Defect:** undecodable or non-object `arguments` are replaced by an empty object and presented as a completed tool call.
- **Failure scenario:** confirmed: upstream answers `tool_calls:[{id:"a", function:{name:"rm", arguments:"{\"path\": \"/tmp/x"}}]`, `finish_reason:"tool_calls"` → client receives `[{"type":"tool_use","id":"a","name":"rm","input":{}}]`, `tool_use`. The client runs the tool with arguments the model never wrote. The request-side rule says the opposite ("never an empty call handed to a model that will act on it", `shared/tools.ts:25-27`), and the streaming half forwards the raw fragments so the client's own JSON parse fails visibly — stream and non-stream disagree. Prior decision recorded in the comment at `openai-chat-to-anthropic/response.ts:121-129` ("not a silent success"); it looks wrong: `stop_reason` says a call was made, not that its input was invented.
- **Fix:** nothing is on the wire for a non-streamed body, so fail honestly: add an optional `translationFailure` to `TranslatedResponse` (`shared/response.ts`), mirroring `StreamTranslator.translationFailure`, set to a `TranslationStreamError("translation_protocol_error", …)` naming the call index (never the value); the relay (dataplane slice, `relay-translate.ts`) renders the ingress-dialect error instead of the body. Keep `{}` for absent/blank arguments (a real no-arg call). Extract the one `toolInput` both files duplicate into `shared/tools.ts`. Update "Tool and function calling" in `docs/idea/06-protocol-translation.md`.
- **Test:** unit, `test/unit/translate/response-pairs.test.ts`: truncated JSON, array, scalar → `translationFailure` set and no `tool_use` with `{}`; blank string → `{}` and no failure. Integration (dataplane slice): mocked upstream with malformed arguments → error body in ingress dialect + `UsageRecord` with the error class.

### 06.5 low — Responses → openai-chat can still end on `finish_reason: null`
- **Kind:** bug
- **Where:** `openai-responses-to-openai-chat/stream.ts:186-193`, `openai-responses-to-openai-chat/response.ts:73,93`
- **Defect:** `fromResponsesCompletion` returns absence for any status other than `completed` / `incomplete`, and both halves put that null on the terminal chunk / final body.
- **Failure scenario:** confirmed: `response.completed` whose `response.status` is `"cancelled"` → `{"delta":{},"finish_reason":null}` then `[DONE]`; non-stream body → `"finish_reason":null`. Contradicts `docs/idea/06-protocol-translation.md:649-652` ("openai-chat has no null finish"). Residual of prior 04.8 (`docs/plans/2026/10/02/101-deep-bug-sweep/04-translation.md:67-72`), which named this file and was applied only to `anthropic-to-openai-chat/response.ts:111`.
- **Fix:** `mapped.value ?? CONSERVATIVE_FINISH_REASON` at both sites, and set `unrecognized` to the odd status so the caller logs it once.
- **Test:** unit, `test/unit/translate/responses.test.ts`: status `cancelled` and missing status on a terminal event / body → `finish_reason: "stop"`, `unrecognizedStopReason` non-null.

### 06.6 low — A chunk carrying `"error": null` is read as an upstream failure
- **Kind:** bug (`unverified` which upstream sends it)
- **Where:** `openai-chat-to-anthropic/stream.ts:124`, `openai-chat-to-openai-responses/stream.ts:114`
- **Defect:** `"error" in payload` is true for a null member; the non-streaming gate checks for an object (`shared/response-error.ts:13-14`).
- **Failure scenario:** confirmed: `{id, error:null, choices:[{delta:{content:"hi"}}]}` → `event: error … "Upstream request failed with status 500"` and the stream is terminated; the content is lost.
- **Fix:** test `payload.error !== null && payload.error !== undefined` (object or string), one helper shared with `response-error.ts`.
- **Test:** unit, `test/unit/translate/translation-stream-edges.test.ts`: both translators, `error: null` chunk → text delta emitted, no error event.

### 06.7 low — A `tool_use` whose `input` is stated on `content_block_start` is replaced by `{}`
- **Kind:** bug (`unverified` which Anthropic-compatible vendor does this)
- **Where:** `anthropic-to-openai-chat/stream.ts:89-97,279-289`, `anthropic-to-openai-responses/stream.ts:60-68,180-188`
- **Defect:** the start schema never reads `content_block.input`; a block with no `input_json_delta` is closed with a synthesized `"{}"`.
- **Failure scenario:** a compatible upstream that sends the whole call on the start event (`input:{"city":"NY"}`, no deltas) → client sees `arguments: "{}"` and runs the tool empty. Real Anthropic always sends `input: {}` plus deltas, so first-party traffic is unaffected.
- **Fix:** read `input` on start; when it is a non-empty object and no delta arrived by `content_block_stop`, emit `JSON.stringify(input)` instead of `"{}"`.
- **Test:** unit, `test/unit/translate/stream-anthropic-openai.test.ts`: start with populated `input`, no deltas, stop → arguments equal the stated object, both target dialects.

### 06.8 low — Forced tool from a Responses client does not get `thinking: disabled`, from a Chat client it does
- **Kind:** bug (`unverified` effect)
- **Where:** `openai-responses-to-anthropic/request.ts:175-189` vs `openai-chat-to-anthropic/request.ts:156-162`
- **Defect:** two ingress dialects aimed at the same egress disagree about the forced-tool rule the module header calls mandatory.
- **Failure scenario:** confirmed: `tool_choice:"required"` + effort `high` → chat ingress emits `thinking:{type:"disabled"}`, Responses ingress does not. On a think-by-default Anthropic-dialect vendor (the MiniMax case cited at `openai-chat-to-anthropic/request.ts:48-51`) the Responses client's force is ignored and it gets prose.
- **Fix:** fold into the shared helper from 06.3 so both return `{tool_choice, thinking?}`; `forcesToolUse` (`shared/structured-output-anthropic.ts:120-122`) stays the single predicate.
- **Test:** unit, `test/unit/translate/forced-tool-thinking.test.ts`: Responses ingress with `required` and with a named function → `thinking.type === "disabled"`.

### 06.9 low — Responses `custom` tools and built-ins are a `400`; the same class from Anthropic is dropped and reported
- **Kind:** bug (prior decision; owner call)
- **Where:** `shared/tools.ts:177-198`, `shared/tools.ts:228-240`
- **Defect:** any Responses tool whose `type` is not `function` refuses the whole request, and the message calls a client-executed `custom` tool "a built-in served inside openai-responses".
- **Failure scenario:** confirmed: `tools:[{type:"function",…},{type:"custom",name:"apply_patch"},{type:"web_search"}]` → `400 tools[1] declares tool type custom, a built-in…`. A Codex-style client that ships its whole toolkit every turn is unservable on any non-Responses account, the exact argument `toolsToOpenAiChat` makes for dropping Anthropic built-ins (`shared/tools.ts:82-89`). Documented as deliberate at `docs/idea/06-protocol-translation.md:936`; the asymmetry with `:445` / `:929` is the point to re-decide.
- **Fix:** drop-and-report server-side built-ins through `onDrop` (thread the sink into `toolsFromOpenAiResponses`), orphaned `tool_choice` goes with it as `toolChoiceForOpenAiChat` already does (`shared/tool-choice.ts:13-38`); keep `400` for `custom` but with a message that names it as a free-form tool with no JSON-schema counterpart. Update both doc rows.
- **Test:** unit, `test/unit/translate/translation-tool-contracts.test.ts`: function + `web_search` → one tool emitted, one drop reported; `custom` → `400` with the corrected wording.

### 06.10 low — Responses-upstream streams pay 2–3× the per-delta cost of the other pairs, and final snapshots re-hash whole payloads
- **Kind:** perf
- **Where:** `shared/responses-item-identity.ts:23,64-77`, `shared/responses-snapshot-recovery.ts:35-44,67,88-102`, `openai-responses-to-anthropic/stream.ts:81-84`, `openai-responses-to-openai-chat/stream.ts:228-231`, `shared/responses-text-boundary.ts:6`
- **Defect:** every delta is spread-copied three times (`{...payload}`, `{...event, item_id}`, `{...event, type, delta}`), tested against two regexes, keyed with `JSON.stringify([item, content_index, kind])`, converted to a UTF-16 `Buffer` and SHA-256-updated, then `type.replace(/\.done$/)`; each `.done` mirror hashes the full final value again.
- **Failure scenario:** measured 8–28 µs/delta for `responses→anthropic` / `responses→chat` vs 4–10 µs for the Anthropic/Chat-upstream pairs; a 512 KB tool-call argument costs 9.6 ms on `function_call_arguments.done` plus 5.7 ms on `output_item.done`, synchronous. Within budget for ordinary turns; the snapshot spikes are not.
- **Fix:** mutate one owned copy instead of three spreads (the payload is this module's own `JSON.parse` result); precompute the event kind from a `Map<string, kind>` instead of `startsWith` ×3 + regex; key evidence by nested `Map` (item → content_index → kind) instead of `JSON.stringify`; when `state.final` is already set and lengths match, compare against a stored final digest and skip nothing else — or keep the final digest so the second mirror costs one hash, not two; hash with `Bun.CryptoHasher` incremental `update(string, "utf16le")` to avoid the `Buffer.from` copy.
- **Test:** unit, existing `responses-final-snapshot.test.ts`, `responses-recovery-identities.test.ts`, `responses-snapshot-boundaries.test.ts`, `responses-unscoped-final.test.ts` must stay green unchanged (they pin the semantics); add one case asserting a repeated equal final mirror emits nothing.

### 06.11 low — Duplicated logic, one dead module, four files over 300 LOC
- **Kind:** structure
- **Where:** dead: `shared/pending-tool-calls.ts` (no importer; superseded by `shared/pending-stream-blocks.ts`; still listed at `docs/reusable-code.md:246`). Over limit: `shared/anthropic.ts` (316), `anthropic-to-openai-chat/stream.ts` (313), `registry.ts` (311), `openai-responses-to-openai-chat/stream.ts` (301). Duplicates: chat chunk schemas `openai-chat-to-anthropic/stream.ts:48-81` ≡ `openai-chat-to-openai-responses/stream.ts:49-82`; chat completion schemas `openai-chat-to-anthropic/response.ts:31-63` ≡ `openai-chat-to-openai-responses/response.ts:30-62`; Anthropic stream event schemas `anthropic-to-openai-chat/stream.ts:79-111` ≡ `anthropic-to-openai-responses/stream.ts:50-83`; `toolInput` ×2 (06.4); tool-policy mapping ×2 (06.3); identity→recovery→parse preamble `openai-responses-to-anthropic/stream.ts:78-118` ≈ `openai-responses-to-openai-chat/stream.ts:225-252`; usage-only chunk literal `anthropic-to-openai-chat/stream.ts:228-237` ≈ `openai-responses-to-openai-chat/stream.ts:196-205`, and the latter re-declares `ToolCallDelta` / `ChunkDelta` / `chunk()` instead of using `shared/chat-stream-chunk.ts`; `isPlainObject` / `isObject` / `asRecord` / `object` defined in 7 files.
- **Defect:** two copies of one wire schema can drift, which is the module's own stated reason for `shared/`.
- **Failure scenario:** a fix to one chunk schema (e.g. 06.6, 06.7) lands in one pair and not its twin.
- **Fix:** delete `pending-tool-calls.ts` and its `reusable-code.md` row; add `shared/openai-chat-wire.ts` (chunk + completion schemas), `shared/anthropic-wire.ts` (the four stream event schemas, moved out of the two stream files — brings `anthropic-to-openai-chat/stream.ts` under 300), `shared/responses-stream-read.ts` (the shared preamble returning `{event} | {failure}`), one `isRecord` in `shared/`; split `shared/anthropic.ts` into parsed schemas vs emitted types; move the six pair literals of `registry.ts` next to their pair directories or trim comments.
- **Test:** no behaviour change — the full `test/unit/translate/` directory green is the gate.

### 06.12 low — Small per-request / per-event allocations
- **Kind:** perf
- **Where:** `shared/cache-control-schema.ts:33` (`toReversed()` copy per message, called again for every message by `hasMarker`, `openai-chat-to-anthropic/request.ts:179-181`); `shared/anthropic-system-turns.ts:31` (`slice` + scan per `system` turn → O(n²) with many system turns); `sse/emit.ts:51-53` (`split("\n")` + loop for payloads that are always single-line JSON); `shared/schema-lookarounds.ts:190` (`JSON.stringify` of every tool schema per translation on Codex egress).
- **Defect:** avoidable copies on paths that run per message or per event.
- **Failure scenario:** 800-message chat transcript → 1600 reversed array copies; `encodeSseEvent` measured 0.09 µs so the emit item is cosmetic.
- **Fix:** index loop from the end in `lastMarker`; compute "a later user turn exists" once (index of last user turn) in the two callers of `isClearedSystemTurn`; fast-path `encodeSseEvent` when `data.indexOf("\n") === -1`.
- **Test:** covered by existing `cache-control-*.test.ts`, `anthropic-system-turns.test.ts`.

### 06.13 low — Parser holds an unterminated line without bound
- **Kind:** memory (`unverified` whether the relay caps upstream bytes)
- **Where:** `sse/parse.ts:59,64,98`
- **Defect:** `buffer` and the `data` array grow until a terminator arrives; nothing bounds them, unlike every other translation backlog (`MAX_TRANSLATION_PENDING_BYTES`).
- **Failure scenario:** a broken upstream streaming bytes with no newline (or endless `data:` lines with no blank line) grows one string per stream until the upstream stops; with 06.1 unfixed it also burns CPU quadratically.
- **Fix:** `createSseParser({ maximumLineBytes })` fed from the existing `env.translation.maximumPendingBytes` (config, not a constant); on overflow surface a `TranslationStreamError("translation_pending_overflow")` through a parser `failure()` the relay checks (dataplane slice wires it).
- **Test:** unit, `sse-parse.test.ts`: over-limit line → failure reported, no frame; at-limit line → frame.

### 06.14 low — Stale comments and undocumented lossy edges
- **Kind:** docs
- **Where / Defect:** see "Doc claims falsified". Undocumented behaviours (pass-through to an upstream `400`, or silent strip): assistant-prefill (trailing assistant turn) anthropic → OpenAI dialects is sent as a finished assistant message, not continued; `temperature` in (1, 2] openai → anthropic; `max_tokens` < 16 → `max_output_tokens` (confirmed `1` carried verbatim; `unverified` OpenAI minimum); more than 4 `stop_sequences` → openai-chat `stop`; legacy `functions` / `function_call` silently stripped (confirmed `tools: undefined`) though they are a contract like `response_format`; function-tool `strict` dropped between the two OpenAI dialects, which both state it (`shared/tools.ts:177-226`, `shared/openai-chat.ts:75-85`).
- **Failure scenario:** operator reads the lossy-edge table, finds no row, and cannot tell a router drop from an upstream refusal.
- **Fix:** add rows to "Known lossy edges" in `docs/idea/06-protocol-translation.md`; refuse `functions` / `function_call` by name in `shared/reject.ts` (same class as `logprobs`); carry a stated `strict` on OpenAI↔OpenAI tool hops.
- **Test:** unit, `request-openai-anthropic.test.ts`: `functions` present → `400` naming `functions`; `tools.test.ts`: `strict: true` survives chat ⇄ responses.

## Checked, not a bug
- Second and later parallel calls from an openai-chat upstream are withheld until the turn ends (confirmed: `tc1` emits nothing until `[DONE]`). Documented ordering policy, `docs/idea/06-protocol-translation.md:577-585`; relay keepalive covers the silence (`dataplane/relay-translate.ts:156-186,224`). Residual: held arguments above `MAX_TRANSLATION_PENDING_BYTES` (1 MiB) fail the stream with `translation_pending_overflow` — by design.
- Usage arithmetic: no double count. Anthropic → OpenAI sums three input fields (`shared/usage.ts:173-182`); OpenAI → Anthropic subtracts cached + written, clamped at 0 (`:195-204,235-239`); reasoning tokens never synthesized; missing = null not 0 except the documented `message_start` zero.
- `message_delta` terminal waits for the trailing usage chunk and `[DONE]`; truncated streams get no synthesized terminator in any of the six stream translators (`flush` in each).
- UTF-8 split across chunks: one streaming `TextDecoder` per parser (`sse/parse.ts:58,119`), flushed at `:150`. `\r\n` split handled (`pendingLf`).
- Tool-call ids preserved verbatim in every direction; orphan tool results refused before upstream (`openai-chat-to-anthropic/request.ts:115-120`, `openai-responses-to-anthropic/request.ts:119-124`, `openai-responses-to-openai-chat/request.ts:187-192`, `openai-chat-to-openai-responses/request.ts:88-93`).
- Tool-result ordering toward OpenAI: results emitted where found, user text/hoisted images after the run (prior 04.1 / 04.2 fixed: `anthropic-to-openai-chat/request.ts:190-205,229-236`, `openai-responses-to-openai-chat/request.ts:111-123,176-182`).
- Thinking blocks never replayed as text; only a seal-opened block returns as a `reasoning` item (`anthropic-to-openai-responses/request.ts:226-239`).
- Prototype-safe lookups: `PAIRS` and `TO_ANTHROPIC` are `Map`s (`registry.ts:285`, `shared/stop-reason.ts:67`).
- Error bodies: upstream message redacted and bounded to 512 chars, type derived from status (`shared/errors.ts:128-134`); reject messages never interpolate body values (`shared/reject.ts`). `tool_choice.type` and tool `type` strings are echoed in a `400` (`shared/tools.ts:187,236`) — structural names from the client's own body, back to the same client.
- `forced-tool-coercion.ts` `coerceStream` takes a whole stream; documented passthrough exception for `thinkingOnByDefault` vendors (`docs/idea/06-protocol-translation.md:939`), caller is `services/dataplane/forced-tool-coercion.ts` (other slice).
- `node:crypto` SHA-256 and `Buffer` in `shared/responses-snapshot-recovery.ts`: deterministic, no I/O — pure.
- Per-shape request translation is memoized (`dataplane/translate-body.ts:148-151`); only differing shapes re-run.
- `text.format` refused on responses → anthropic while `response_format` is carried chat → anthropic: stated one-direction decision (`shared/reject.ts:229-231`).

## Doc claims falsified
- `docs/idea/06-protocol-translation.md:649-652` says openai-chat never ends on a null finish; `openai-responses-to-openai-chat/stream.ts:193` and `response.ts:93` emit one (06.5).
- `docs/reusable-code.md:246` advertises `createPendingToolCalls()`; nothing imports `shared/pending-tool-calls.ts`.
- `shared/tools.ts:25-27` says an undecodable arguments string is "never an empty call handed to a model"; `openai-chat-to-anthropic/response.ts:130-140` hands one to the client (06.4).
- `shared/anthropic-system-turns.ts:7-10` says both OpenAI dialects get a `developer` turn; `anthropic-to-openai-chat/request.ts:113-117` emits `system` (the doc at `06-protocol-translation.md:410` is right, the comment is stale).
- `shared/openai-chat.ts:9-13` says `response_format` is declared only to be refused; it is carried (`shared/structured-output.ts`, `shared/structured-output-anthropic.ts`).
- `shared/openai-responses.ts:9-16` says `reasoning` items are refused by name; they are dropped (`openai-responses-to-anthropic/request.ts:133-136`).
- `openai-chat-to-anthropic/request.ts:39` cites `06-protocol-translation.md:119-121` for the merge rule; that range is the models-endpoint text now (rule lives near `:424`).

## Steps
1. 06.1 + 06.13: rewrite `consume` in `sse/parse.ts` to linear scan with a line cap option; tests first.
2. 06.3 + 06.8: add the shared Anthropic tool-policy helper in `shared/tools.ts`; switch both `* → anthropic` request translators; doc row `:962`.
3. 06.4: `translationFailure` on `TranslatedResponse`, shared `toolInput`; coordinate the relay change with the dataplane slice; doc update.
4. 06.5, 06.6, 06.7: three small stream/response fixes, each with its failing test first.
5. 06.2: discriminated dispatch in the three request schemas; then the parse/emit split with the dataplane slice.
6. 06.10, 06.12: per-delta and per-message allocation cleanup; record `bun run` before/after numbers in the PR.
7. 06.11: delete dead module, extract shared wire schemas, bring four files under 300 LOC — last, so it does not conflict with steps 2–5.
8. 06.9, 06.14: owner decision on Responses built-ins / `custom`; doc rows, stale comments, `functions` refusal, `strict` carry.
9. `CHANGELOG.md` + version bump in the same PR as each behaviour change.

## Tests
- Extend: `test/unit/translate/sse-parse.test.ts`, `parallel-and-refusal.test.ts`, `forced-tool-thinking.test.ts`, `response-pairs.test.ts`, `responses.test.ts`, `translation-stream-edges.test.ts`, `stream-anthropic-openai.test.ts`, `translation-tool-contracts.test.ts`, `request-openai-anthropic.test.ts`, `request-anthropic-openai.test.ts`, `tools.test.ts`.
- `bun test apps/api/test/unit/translate`; `bunx biome check apps/api/src/services/translate apps/api/test/unit/translate`; `bun run typecheck` once at end. Never a bare root `bun test`, never `bin/check` per slice.

## Done when
- A 4 MiB single-line SSE event in 16 KiB chunks parses in time linear to its size (≤ ~4× the 1 MiB case), and an over-limit line fails with `translation_pending_overflow`.
- `tool_choice:"none"` never carries `disable_parallel_tool_use`; both `* → anthropic` translators produce identical tool policy + thinking for identical intent.
- No non-streaming translated response contains a `tool_use` whose `input` was invented from undecodable arguments.
- No openai-chat terminal chunk or body has `finish_reason: null`.
- `shared/pending-tool-calls.ts` gone; no file in `services/translate/` over 300 LOC; one copy of each wire schema.
- Every row in "Doc claims falsified" corrected.

## Not covered
- Upstream verdicts marked `unverified` (06.3 Anthropic strictness on `none`, 06.6, 06.7, OpenAI `max_output_tokens` minimum, Responses default for an omitted `strict`) — no live provider may be hit.
- `services/dataplane/relay-translate.ts`, `translate-body.ts`, `forced-tool-coercion.ts` read only as callers; their abort/backpressure handling belongs to the transport/dataplane slice.
- `providers/claude-sdk/render/` output shape (consumed by the Anthropic-upstream translators) not audited.
- Tests under `test/unit/translate/` skimmed by name and targeted grep, not read line by line; integration `translate.test.ts` / `codex-translate.test.ts` not read.
- Benchmarks are single-run `bun run` numbers on a dev machine (JIT-noisy, ±2×); ratios, not absolutes, are the evidence.
