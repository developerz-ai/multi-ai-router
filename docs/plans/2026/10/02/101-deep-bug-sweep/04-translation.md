# 04 — Protocol translation

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/translate/`, `apps/api/test/unit/translate/`, `apps/api/src/services/dataplane/relay-translate.ts`, `apps/api/src/services/dataplane/translate-body.ts`, `docs/idea/06-protocol-translation.md`.

Confirmed with throwaway probes in `/tmp/claude-1001/probe/` (bun test against the real exports): 04.1, 04.2, 04.3, 04.4, 04.16, 04.17. Everything else was traced through the code by hand. A finding marked `unverified` depends on how some upstream behaves, which nobody checked against a live provider.

Passthrough is clean. Same-dialect requests splice the model span and nothing else (`dataplane/chain.ts:260-267`, `body/read.ts:125`), `relay.ts` never parses a body, and `relay-translate.ts` emits each translated event as soon as it exists. No translator holds a clock, a store or a logger.

## Findings

### 04.1 high — Parallel Responses `function_call` items become separate assistant messages toward openai-chat
- **Where:** `apps/api/src/services/translate/openai-responses-to-openai-chat/request.ts:151-160` (one `{role:"assistant", tool_calls:[call]}` per item). The "not merged" rationale is at `:44-48`.
- **Defect:** Consecutive `function_call` items are never folded into one assistant message, so the body puts one assistant message after another, and each holds an unanswered `tool_calls` entry.
- **Failure scenario:** A Responses client (OpenAI Agents SDK, Codex-style loop) makes 2 parallel calls and then replays `[user, function_call a, function_call b, function_call_output a, function_call_output b]`. The router sends `[user, assistant{tool_calls:[a]}, assistant{tool_calls:[b]}, tool a, tool b]` (probe confirmed). OpenAI and other strict upstreams reply `400 "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'"`. Every turn after the first parallel call fails.
- **Fix:** In `appendItem`, when the previous emitted message is an assistant message with no `tool_call_id`, append the call to that message's `tool_calls` instead of pushing a new message. The same applies to an assistant `message` item immediately followed by `function_call` items: the text and the calls become one message. Leave user and system messages unmerged. Update the doc comment at `:44-48`.
- **Test:** Unit test in `test/unit/translate/responses.test.ts` that feeds 2 calls and 2 outputs and asserts `roles == [user, assistant, tool, tool]` with `assistant.tool_calls.length == 2`. A second case covers text followed by a call.

### 04.2 high — An image hoisted out of a `tool_result` splits a run of tool messages toward openai-chat
- **Where:** `apps/api/src/services/translate/anthropic-to-openai-chat/request.ts:135-156`. `merge` at `:193-210` never moves anything past a tool message.
- **Defect:** The hoisted `user` image message is pushed immediately after its own `tool` message, so it lands between that tool result and the next one.
- **Failure scenario:** Claude Code makes parallel calls (`Read` of a screenshot, then `Bash`). The user turn is `[tool_result a (image), tool_result b]`. The router sends `[assistant{tool_calls:[a,b]}, tool a, user(image), tool b]` (probe confirmed). OpenAI returns 400 because `b` has no tool response directly after the assistant message. The session dies on any parallel batch whose image result is not the last one.
- **Fix:** Collect the hoisted images for the whole Anthropic user turn and emit them as one `user` draft after the last `tool` draft of that turn, in their original order. Let `merge` fold that draft into the turn's own text. Check the Responses sibling (`anthropic-to-openai-responses/request.ts:156-175`) too: it interleaves the same way, and whether the Responses API rejects that is `unverified`.
- **Test:** The existing hoist test at `request-anthropic-openai.test.ts:327` covers one result. Add a case with 2 results where the image is in the first one, and assert that every `tool` message comes before the first new `user` message.

### 04.3 high — The router emits `reasoning` items that its own translators refuse when the client sends them back
- **Where:** Emitted at `openai-chat-to-openai-responses/response.ts:323-326`, `openai-chat-to-openai-responses/stream.ts:131`, `anthropic-to-openai-responses/response.ts:89-92` and `anthropic-to-openai-responses/stream.ts:124-126`. Refused at `openai-responses-to-openai-chat/request.ts:147-149` and `openai-responses-to-anthropic/request.ts:118-121`, both via `shared/reject.ts:161`.
- **Defect:** The `rs_…` items are summary-only and router-synthesized, and they hold no provider state. Yet a request that replays one is refused as "conversation state held by the provider".
- **Failure scenario:** A Responses client talks to DeepSeek-R1, GLM or QwQ on an openai-chat account (or to a Claude account with thinking turned on). Turn 1 returns `output: [{type:"reasoning", id:"rs_c1_0", …}, message]`. The client sends its stateless transcript back (Agents SDK `to_input_list()`). Turn 2 gets `400 "input[1] is a reasoning item, which names conversation state…"` (probe confirmed for both egresses). Every multi-turn reasoning conversation breaks on its second request.
- **Fix:** On non-Responses egress, drop a `reasoning` input item that carries no `encrypted_content` (only `summary` plus an id), treating it as a documented hint, the same way an Anthropic `thinking` block is dropped toward openai-chat. Keep refusing `item_reference`, and a `reasoning` item whose `encrypted_content` is non-empty. Change `rejectStatefulItem`'s callers rather than the schema. Update the spec at `06-protocol-translation.md:201-203` and the row at `:610`.
- **Test:** A round-trip unit test: take the `output` of `openAiChatToOpenAiResponsesResponse` with `reasoning_content`, put it back into `input`, and assert that both `openAiResponsesToOpenAiChatRequest` and `openAiResponsesToAnthropicRequest` succeed and contain no reasoning text. Keep a test showing that an `encrypted_content` item is still refused.

### 04.4 medium — Responses → openai-chat stream: an upstream failure leaves the stream with no terminal chunk and no `[DONE]`
- **Where:** `apps/api/src/services/translate/openai-responses-to-openai-chat/stream.ts:176-184`. Compare the sibling that was fixed, `anthropic-to-openai-chat/stream.ts:242-254`.
- **Defect:** `onFailed` emits only the error object and sets `closed`. `flush` then returns nothing because `finished` is still false.
- **Failure scenario:** opencode, an openai-chat client, uses a ChatGPT/Codex `openai-responses` account. The upstream sends `response.failed` mid-answer. The client receives the text deltas and then `{"error":…}`, then EOF with no `finish_reason` chunk and no `[DONE]` (probe confirmed). That is the `Failed to read … stream` hang from 2026-09-06 that the spec says is fixed (`06-protocol-translation.md:471-476`).
- **Fix:** Mirror `anthropic-to-openai-chat/stream.ts:242-254`: after the error object, push `chunk({}, CONSERVATIVE_FINISH_REASON)` if `!finished`, then push `DONE`, then set `finished = closed = true`.
- **Test:** Unit test: `response.created`, a text delta, then `response.failed`. Assert the last three emitted frames are the error, a chunk whose `finish_reason` is `"stop"`, and `[DONE]`. Add the same case for a bare `error` event.

### 04.5 medium — Streamed Responses refusals (`response.refusal.delta`) are dropped
- **Where:** `openai-responses-to-anthropic/stream.ts:84-89` and the `default` branch at `:127-130`. `openai-responses-to-openai-chat/stream.ts:200-215`. The non-streaming path carries refusals as text (`shared/responses-read.ts:154`).
- **Defect:** The `response.refusal.delta` event has no case, so a refusal written by the model never reaches the client.
- **Failure scenario:** An OpenAI model refuses. An Anthropic or openai-chat client that streamed gets an empty assistant turn with `end_turn` / `stop`, while the same request without streaming returns the refusal sentence. Stream and non-stream disagree, and the client sees a silent empty answer.
- **Fix:** Handle `response.refusal.delta` exactly as `response.output_text.delta` in both stream translators. That carries the refusal as text, which matches `responses-read.ts:122-128`.
- **Test:** In each pair, a stream unit test that feeds `response.refusal.delta` and asserts the text is emitted.

### 04.6 medium — A Responses `function_call_output` holding an image is a 400 on every non-Responses egress
- **Where:** `openai-responses-to-anthropic/request.ts:110-114` (`blocksText` refuses at `shared/anthropic-turns.ts:283-291`). `openai-responses-to-openai-chat/request.ts:170` and `:251-253`.
- **Defect:** An image in a tool output is refused, although Anthropic `tool_result` holds images natively and the reverse direction hoists them (`shared/anthropic-blocks.ts:61-80`).
- **Failure scenario:** An Agents SDK or Codex computer-use or screenshot tool returns `output:[{type:"input_image", image_url:"data:…"}]`. On a Claude or openai-chat account the turn is a 400 the agent cannot rewrite. That is the exact failure the hoisting rule was written to remove (`06-protocol-translation.md:300`, `:309-311`).
- **Fix:** Toward anthropic, emit `tool_result.content` as a block array (text plus image) when an image is present. That widens `AnthropicToolResultBlock` in `shared/anthropic.ts:419-423`. Toward openai-chat, put the text in the tool message and hoist the images into one user message after the run of tool messages, which is the same placement 04.2 needs.
- **Test:** Unit tests for both pairs: a `function_call_output` with text and an image. The Anthropic body carries an image block inside the `tool_result`, and the chat body carries the image after the last tool message.

### 04.7 medium — openai-chat → Anthropic: tool calls with `finish_reason` other than `tool_calls` report `end_turn` (`unverified` upstream behaviour)
- **Where:** `openai-chat-to-anthropic/stream.ts:93-96` and `:134-139`. `openai-chat-to-anthropic/response.ts:90`. The Responses sibling infers the reason from the items (`openai-responses-to-anthropic/response.ts:205`, `stream.ts:50`).
- **Defect:** The stop reason is read from `finish_reason` alone, so `stop` (or `[DONE]` with no finish reason) together with `tool_calls` becomes `stop_reason:"end_turn"` on a message whose content includes `tool_use` blocks.
- **Failure scenario:** Gemini's OpenAI-compatible endpoint and some Ollama and vLLM builds are reported to answer tool calls with `finish_reason:"stop"`. An Anthropic SDK agent loop or tool runner that branches on `stop_reason === "tool_use"` then ends the turn without running the call.
- **Fix:** Track whether any `tool_calls` delta (stream) or `message.tool_calls` entry (non-stream) was seen. When one was and the mapped reason is `end_turn` or absent, return `tool_use`. Do the same in `openai-chat-to-openai-responses` only if a status is affected (it is not today).
- **Test:** A stream test and a non-stream test where `finish_reason` is `"stop"` and tool calls are present. Expect `tool_use`.

### 04.16 medium — An index-less upstream that repeats the call `id` on every fragment gets one `tool_use` block per fragment (`unverified` which upstreams do this)
- **Where:** `shared/openai-chat-tool-calls.ts:284-311`. `key()` calls `mint()` whenever an entry names an `id`, even an `id` it has already keyed.
- **Defect:** A continuation entry that repeats its call's `id` is read as a new call, so the arguments split across two blocks that share one id.
- **Failure scenario:** Chunk 1 is `{id:"a", function:{name:"f", arguments:'{"x":'}}` and chunk 2 is `{id:"a", function:{arguments:'1}'}}`, with no `index` on either. Toward anthropic this emits `tool_use{id:"a", name:"f"}` with partial `{"x":` and a second `tool_use{id:"a", name:""}` with partial `1}` (probe confirmed). Both inputs are invalid JSON, so the client's next turn has two `tool_use` blocks with the same id and Anthropic returns 400. The Responses emitter shares the reader and fails the same way.
- **Fix:** In `key()`, remember the key minted for each stated `id` (a `Map<id, key>`). An entry whose `id` is already known resolves to that key and sets `last` to it. Only an unseen `id`, or a name with no `id`, mints a new key.
- **Test:** A unit test in `stream-openai-anthropic.test.ts` with the two chunks above. Assert one `tool_use` block whose partials join to `{"x":1}`.

### 04.8 low — Anthropic → openai-chat non-streaming can return `finish_reason: null`
- **Where:** `anthropic-to-openai-chat/response.ts:197` and `:215`. The stream half falls back at `stream.ts:214`.
- **Defect:** A null `stop_reason` maps to a null `finish_reason` on a completed `chat.completion`. That breaks the rule at `06-protocol-translation.md:461-469` that openai-chat has no null finish.
- **Failure scenario:** An Agent-SDK turn ends mid-block, so the renderer emits `stop_reason:null`, and an openai-chat client without streaming gets `finish_reason:null`. Strict clients (OpenAI SDK typed parse, LangChain) treat that as unfinished or malformed.
- **Fix:** Use `mapped.value ?? CONSERVATIVE_FINISH_REASON` for the non-streaming body, as the stream does. Do the same in `openai-responses-to-openai-chat/response.ts:69`.
- **Test:** A unit test where `stop_reason: null` should produce `finish_reason: "stop"`.

### 04.9 low — Text arriving while a tool block is open closes that block, and the call's later arguments are silently dropped (`unverified` that any upstream does this)
- **Where:** `shared/anthropic-stream.ts:189-201`, with the drop at `:222-240` (`open.index !== index` returns). `shared/responses-stream.ts:175-188` and `:255-266` (`pending.append` returns false).
- **Defect:** `text()` calls `closeOpen`, so a later `input_json_delta` for the closed call is discarded. The result is a `tool_use` with truncated `input` and `stop_reason: tool_use`.
- **Failure scenario:** A chat upstream sends `{content:"\n", tool_calls:[{index:0, arguments:"…rest"}]}` in one chunk after the call opened. The client runs the tool with incomplete arguments, which is exactly the failure `pending-tool-calls.ts:164-167` exists to prevent.
- **Fix:** While a tool block is open, route text through a pending text buffer and flush it on `closeBlock`. Alternatively, process `tool_calls` before `content` within a chunk and treat whitespace-only text that arrives during an open call as part of the next text block.
- **Test:** A stream test with interleaved content and arguments for an open call. Assert that the full arguments reach the `tool_use` block.

### 04.10 low — `disable_parallel_tool_use` ⇄ `parallel_tool_calls` is never mapped
- **Where:** `shared/anthropic.ts:370-375` (strict object strips `disable_parallel_tool_use`), `anthropic-to-openai-chat/request.ts:87-102`, `anthropic-to-openai-responses/request.ts:93-109`, and `openai-chat-to-anthropic/request.ts:111-127`.
- **Defect:** The caller's "one call per turn" contract disappears in both directions.
- **Failure scenario:** An Anthropic client sends `tool_choice:{type:"auto", disable_parallel_tool_use:true}` to an OpenAI account, gets 3 parallel calls back, and its sequential executor breaks.
- **Fix:** Read `disable_parallel_tool_use` and emit `parallel_tool_calls:false` toward both OpenAI dialects. In reverse, turn `parallel_tool_calls:false` into `tool_choice.disable_parallel_tool_use:true`, defaulting the type to `auto` when no `tool_choice` was sent. Update the row at `06-protocol-translation.md:331`.
- **Test:** Request unit tests in both directions.

### 04.11 low — A no-argument call has `arguments: ""` when streamed but `"{}"` when not
- **Where:** `anthropic-to-openai-chat/stream.ts:165` and `:189-193` versus `response.ts:193`. `anthropic-to-openai-responses` stream (`shared/responses-stream.ts:169-173` accumulates `""`) versus `response.ts:83`.
- **Defect:** Anthropic streams an empty `input` as `partial_json:""` (or sends no delta at all), so the streamed call's arguments end up as the empty string, which is not valid JSON.
- **Failure scenario:** A client that runs `JSON.parse(arguments)` on the completed call throws on a no-arg tool, but only when streaming.
- **Fix:** At `content_block_stop` for a tool block that received no non-empty arguments, emit one `"{}"` arguments delta. In Responses, have the `function_call_arguments.done` event and the item carry `"{}"`.
- **Test:** A stream test where `tool_use` has no deltas. Assert the accumulated arguments are `"{}"`.

### 04.12 low — The 4096 default `max_tokens` is called "generous" but cuts off modern answers
- **Where:** `shared/anthropic.ts:266` and `apps/api/src/config/env.ts:1104`.
- **Defect:** An OpenAI or Responses client that omits a ceiling (the normal case) gets 4096 output tokens on Claude.
- **Failure scenario:** A long code generation from opencode or LangChain over an Anthropic account stops at 4096 with `finish_reason:"length"`. The spec says the default must not cause this (`06-protocol-translation.md:597`).
- **Fix:** Raise the shipped default (Claude models accept far more), or make it per model from the catalog's max output. It stays configurable through `TRANSLATE_DEFAULT_MAX_TOKENS`.
- **Test:** An env unit test for the new default. A translator test that an omitted ceiling equals the configured value.

### 04.13 low — An Anthropic stop reason outside the shipped set falls back to `stop` / `completed`
- **Where:** `shared/stop-reason.ts:25-32` and `:57-67`.
- **Defect:** Newer Anthropic models can return `model_context_window_exceeded` (`unverified` against the live API). It is not in the "closed" set, so it maps to `stop`, when it describes truncation.
- **Failure scenario:** An openai-chat client sees `finish_reason:"stop"` (Responses sees `completed`) on an answer the context window cut short, and treats it as complete.
- **Fix:** Add `model_context_window_exceeded` with mappings to `length` and `max_output_tokens`. Fix the "closed and complete" sentence at `06-protocol-translation.md:443`.
- **Test:** A stop-reason table unit test.

### 04.14 low — Arguments or text that a Responses upstream states only on `.done` / `output_item.done` are ignored (`unverified`)
- **Where:** `openai-responses-to-anthropic/stream.ts:98-100` and `openai-responses-to-openai-chat/stream.ts:91-111`.
- **Defect:** Only delta events carry content forward. `output_item.done.item.arguments` and `output_text.done.text` are never compared with what was already streamed.
- **Failure scenario:** A Responses-compatible upstream (vLLM or Azure variants) that sends a whole function call in `output_item.added` or `done` with no argument deltas produces a `tool_use` with `input:{}`.
- **Fix:** For each item, track the bytes already emitted. On `output_item.done`, if the item's `arguments` is longer than what was emitted, emit the remaining suffix before closing.
- **Test:** A stream test: `added`, then `done` carrying full arguments, with no deltas in between.

### 04.15 low — An Anthropic `image` with a `file` source is a 400 instead of a drop-and-report
- **Where:** `shared/anthropic.ts:280-285` (the union only has `base64` and `url`). Because the `refine` at `:343` excludes known types, the block also cannot fall through to `unsupportedBlock`.
- **Defect:** A valid Files-API image block is refused as malformed. A `document` with a `file` source is dropped and reported (`anthropic-blocks.ts:90-103`), so images and documents are treated differently.
- **Failure scenario:** A Claude Code transcript containing `{type:"image", source:{type:"file", file_id}}` is sent to an OpenAI account, and the whole turn is a 400.
- **Fix:** Add a loose `file` source variant and drop-and-report it in both `anthropic → *` translators.
- **Test:** A request unit test asserting one drop and no throw.

### 04.17 low — Tool-call arguments that arrive after `finish_reason` are silently dropped (`unverified` that any upstream does this)
- **Where:** `openai-chat-to-anthropic/stream.ts:134-139` (`closeBlock` on finish), where later args hit `shared/anthropic-stream.ts:229`. Also `openai-chat-to-openai-responses/stream.ts:138-143` with `shared/responses-stream.ts:255-266`.
- **Defect:** The finish chunk closes every block, so an argument fragment for index 0 that comes after it is discarded, and the stop reason still says `tool_use`.
- **Failure scenario:** Fragments arrive in this order: `{index:0, arguments:'{"x":'}`, then `finish_reason:"tool_calls"`, then `{index:0, arguments:'1}'}`. The client gets `input` `{"x":` (probe confirmed), which is a broken call with no signal that anything went wrong.
- **Fix:** When the finish reason arrives, record it but defer `closeBlock` to `[DONE]` or flush (both already terminate). The block-stop latency this adds is one chunk at most.
- **Test:** A stream test with the order above. Assert the arguments are whole.

### 04.18 low — A usage chunk with `choices: []` is sent to openai-chat clients that never asked for one
- **Where:** `anthropic-to-openai-chat/stream.ts:216-228` and `openai-responses-to-openai-chat/stream.ts:159-171`. The client's `stream_options.include_usage` is never read, because the translator only sees the upstream.
- **Defect:** OpenAI sends that chunk only when `stream_options.include_usage` is set. This path always sends it.
- **Failure scenario:** A naive client that reads `chunk.choices[0].delta` on every chunk (common in scripts and older SDK wrappers) throws `TypeError` on the last chunk before `[DONE]`. That happens only when the router is translating, never on a passthrough to OpenAI.
- **Fix:** Pass `includeUsage` (read from the client's body in `translate-body.ts`, which already parses it) through `TranslationContext`, and emit the usage chunk only when it is true. The `UsageRecord` is unaffected, because it reads upstream bytes (`relay-translate.ts:182`). Update `06-protocol-translation.md:527-528`, which documents the unconditional emit.
- **Test:** Stream unit tests with `includeUsage` false (no `choices: []` chunk) and true (chunk present).

### 04.19 low — An HTTP-200 JSON error body is translated into an empty successful completion (`unverified` which upstreams answer this way)
- **Where:** `dataplane/relay-translate.ts:243-254` hands any 2xx JSON to `pair.response`. `openai-chat-to-anthropic/response.ts:70-105`, `anthropic-to-openai-chat/response.ts:178-223` and the other response translators never check for a top-level `error`, although every stream reader does (for example `openai-chat-to-anthropic/stream.ts:112`).
- **Defect:** `{"error":{…}}` with status 200 becomes `content: []`, `stop_reason: null` and `usage.output_tokens: 0`.
- **Failure scenario:** An OpenAI-compatible aggregator returns 200 with an error envelope. The Anthropic client receives an empty assistant message, which looks like a model that said nothing, and the upstream's message is lost.
- **Fix:** In `translate()` (`relay-translate.ts:243`), when the parsed body has a top-level `error` object, render it with `translateUpstreamError(…, 502, ingress)` instead of calling `pair.response`. That needs the ingress, which the pair has. Whether the attempt should also be recorded as a failure is a chain decision for area 1/2.
- **Test:** A relay unit test where a 200 `{"error":{"message":"x"}}` comes back as an ingress-shaped error body.

## Mid-stream error matrix (second dive)
| Upstream → client | Terminal on upstream error | Verdict |
|---|---|---|
| anthropic → openai-chat | error object, finish chunk, `[DONE]` (`anthropic-to-openai-chat/stream.ts:242-254`) | ok |
| openai-responses → openai-chat | error object only | **04.4** |
| openai-chat → anthropic | `event: error` (`shared/anthropic-stream.ts:258-263`) | ok. Anthropic ends on `error` |
| openai-responses → anthropic | `event: error` from `response.failed` or `error` | ok |
| anthropic → openai-responses | `response.failed` (`shared/responses-stream.ts:284-293`) | ok |
| openai-chat → openai-responses | `response.failed` | ok |
| any pair, transport cut | nothing, by design (`06-protocol-translation.md:493-496`) | ok |

Verified clean in this dive:
- UTF-8 multi-byte split across chunks. `TextDecoder` with `stream:true` (`sse/parse.ts:268`) reassembled `é😀` split at byte 12 and byte 15 (probe confirmed).
- Responses `sequence_number` is monotonic per emitter, and `output_index` equals the item's position in `items` (open drafts are pushed on close, one open at a time).
- Back-pressure: `upstream.pipeTo(transform.writable)` (`relay-translate.ts:193`).
- Client abort reaches upstream: the client signal goes into the fetch (`attempt.ts:80`), and a cancelled readable rejects `pipeTo` and cancels the source.
- Only the Responses emitter keeps the whole answer (`responses-stream.ts:104`, `draft.text`), and the spec says it must, to restate it in `response.completed`. The other emitters hold only pending tool-call fragments.
- Ceiling names: `max_completion_tokens` wins over `max_tokens` (`openai-chat-to-anthropic/request.ts:114-118`).
- `n > 1`, `logprobs` and `response_format: json_schema` are refused with a 400 toward Anthropic and toward Responses. No tool trick is attempted; the refusal is the documented choice.

## Steps
1. 04.1 and 04.2/04.6 share the "the tool-message run must be contiguous" rule. Fix 04.1 in `openai-responses-to-openai-chat/request.ts`, then add a shared hoist-after-run helper used by `anthropic-to-openai-chat/request.ts` and the Responses→chat image case.
2. 04.3: relax the `reasoning` item refusal in the two `openai-responses → *` request translators, and update the spec.
3. 04.4: add the terminal chunk and `[DONE]` in `openai-responses-to-openai-chat/stream.ts`.
4. 04.5: handle `response.refusal.delta` in both Responses stream readers.
5. 04.6: allow image `tool_result` content toward anthropic (`shared/anthropic.ts`, `openai-responses-to-anthropic/request.ts`).
6. 04.7 and 04.8: stop-reason inference and fallback in `openai-chat-to-anthropic/*` and `anthropic-to-openai-chat/response.ts`.
7. 04.16: id-aware keying in `shared/openai-chat-tool-calls.ts`. It is one file and fixes both emitters.
8. Low findings as capacity allows. Each touches one pair, except 04.9 and 04.17, which touch the two emitters, and 04.18, which threads `includeUsage` through `TranslationContext` and `translate-body.ts`.

## Tests
- Unit tests in `apps/api/test/unit/translate/`, with fixtures only and no I/O. Write the failing case first for each finding (probe inputs are listed in each finding).
- Integration (`test/integration/translate.test.ts`): one mocked-upstream case each for 04.1 (Responses ingress, chat upstream that validates tool adjacency) and 04.4 (Responses upstream sends `response.failed`, chat client sees `[DONE]`).

## Done when
- The probe scenarios in 04.1–04.4 produce bodies or streams a strict OpenAI validator accepts, and a replayed router-emitted `reasoning` item no longer 400s.
- Streaming and non-streaming agree on refusal text (04.5), the null finish fallback (04.8) and no-arg arguments (04.11).
- `bin/check` passes, and `06-protocol-translation.md` is updated in the same PR (non-negotiable: behaviour change, spec change).

## Falsified doc claims
- `06-protocol-translation.md:313-320` and the doc comment `openai-responses-to-openai-chat/request.ts:44-48` say the item list *is* the message list and merging is unnecessary. That is false for consecutive `function_call` items (04.1).
- `06-protocol-translation.md:300` and `:602` say a hoisted image lands "directly after the tool message", which they present as always safe. With more than one tool result it breaks the tool run (04.2).
- `06-protocol-translation.md:201-203` (reasoning items are stateful and refused) together with `:611-612` (the router emits reasoning summary items): the router refuses its own output (04.3).
- `06-protocol-translation.md:471-476` says an upstream error mid-stream always terminates the stream. That does not hold for Responses → openai-chat (04.4).
- `06-protocol-translation.md:443` says the Anthropic `stop_reason` set is closed and complete (04.13, unverified).
- `06-protocol-translation.md:597` says the default ceiling is "generous" (04.12).

## Not covered
- Whether the attempt deadline (`dataplane/attempt.ts:80`, `attemptDeadline`) also caps a long *streaming* body after the headers arrive. That is area 1/2. If it does, a long translated stream ends as a transport cut, which by design gets no terminator.
- Mid-transcript `system`/`developer` messages are moved into the single top-level system prompt toward anthropic (`openai-chat-to-anthropic/request.ts:71-77`). This is documented, but it changes when the model sees the instruction. Not ranked.
- openai-chat `delta.refusal` / `message.refusal` is not read by the chat→anthropic or chat→responses readers. It only appears with structured outputs, which are refused cross-dialect, so it was not ranked. Revisit if 04.5 is fixed.
- The Agent-SDK re-synthesis renderer (`providers/claude-sdk/render/`), which belongs to area 3. Only how its output is consumed here was checked (null stop reason, 04.8).
- Live upstream quirks: whether Mistral accepts `stream_options` (it is always sent on translated streams, `anthropic-to-openai-chat/request.ts:97`), whether Gemini compat states `finish_reason:"tool_calls"`, and whether DeepSeek or Kimi thinking-mode tool loops require `reasoning_content` echoed back (it is dropped toward chat, `anthropic-to-openai-chat/request.ts:163-167`).
- Anthropic models refusing `temperature` and `top_p` together. Translators forward both whenever the client sent both (`openai-chat-to-anthropic/request.ts:120-121`), so the upstream returns an honest 400. That is policy, not something checked here.
- **Cross-area (area 1 / 3):** `dataplane/egress/headers.ts:65-72` (`clientHeaders`) relays every upstream response header except hop-by-hop ones, on both passthrough and translate relays. That includes `anthropic-organization-id`, `openai-organization` and `openai-project`, which identify the upstream account to every router-key holder. It contradicts "no body ever carries … the identity of the account" (`06-protocol-translation.md:542`), in spirit if not by the letter.
