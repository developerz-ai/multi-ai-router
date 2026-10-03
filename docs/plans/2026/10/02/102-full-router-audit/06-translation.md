# 06 — Translation

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/api/src/services/translate/`, `apps/api/test/unit/translate/`, `apps/api/test/integration/translate.test.ts`. Documentation edits coordinated through the overview.

## Findings

### 06.1 high — Parallel Responses calls become an invalid Chat Completions transcript
- **Where:** `apps/api/src/services/translate/openai-responses-to-openai-chat/request.ts:151`, especially `:159`.
- **Defect:** Every Responses `function_call` becomes a separate assistant message, even when consecutive calls are one parallel assistant turn.
- **Failure scenario:** Valid Responses history `[call A, call B, output A, output B]` becomes Chat history `[assistant(tool_calls:[A]), assistant(tool_calls:[B]), tool(A), tool(B)]`. A Chat provider requiring tool replies directly after the assistant tool-call group rejects the translated history; the caller's next agent turn fails despite both tool outputs being supplied.
- **Proof:** Pure translator invocation with calls `a/toolA`, `b/toolB` and matching outputs emitted the four-message sequence above. Expected grouping is one assistant message carrying both calls, followed by the two results.
- **Fix:** Group calls belonging to the same contiguous assistant turn into one `tool_calls` array while preserving call IDs and order. Respect user/tool boundaries and any assistant text associated with that turn. Keep unmatched-call rejection; do not synthesize missing results or reorder independent turns.
- **Test:** Failure first in `responses.test.ts`: two and three consecutive calls plus results produce one assistant group and all matching tool messages. Cover assistant text with calls, mixed sequential turns, results in a different permitted order, and unknown result IDs. Mocked upstream integration should validate Chat tool-turn sequencing and assert one UsageRecord for the completed request.

### 06.2 medium — Streamed Responses refusals disappear in both target dialects
- **Where:** `apps/api/src/services/translate/openai-responses-to-openai-chat/stream.ts:195`; `apps/api/src/services/translate/openai-responses-to-anthropic/stream.ts:62`.
- **Defect:** Both streaming translators ignore `response.refusal.delta`, although non-streaming Responses parsing preserves refusal text.
- **Failure scenario:** Responses provider streams a refusal sentence followed by `response.completed`. A Chat or Anthropic caller receives no refusal text and an apparently successful empty answer; the same provider answer with streaming disabled contains the refusal.
- **Proof:** Passing `{ type: "response.refusal.delta", delta: "Cannot comply" }` as an SSE frame returned `[]` from both translators. Contrast `shared/responses-read.ts:154`, which reads `part.refusal` for non-streaming output.
- **Fix:** Map refusal deltas into the same visible refusal/text representation already used for non-streaming translation. Emit content incrementally; do not buffer for the terminal response. Ignore `.done` mirrors once their deltas have been emitted, preserving normal completion/error handling.
- **Test:** Failure first in `responses.test.ts`: refusal-only and mixed-content streams into both dialects preserve the complete sentence, one fragment at a time, with no duplicates at `.done`/completion. Compare assembled streaming text with the corresponding non-streaming translation.

## Documentation claims falsified
- `docs/idea/06-protocol-translation.md:330` describes parallel calls as cleanly translated; the Responses-to-Chat request direction breaks the next parallel-tool turn.
- `docs/idea/06-protocol-translation.md:362` describes text deltas as clean; refusal text disappears only when streamed. Document its supported mapping explicitly beside ordinary text.

## Steps
1. Add the parallel-call transcript failure case; implement grouping in the owning request translator.
2. Add refusal parity tests and map refusal deltas in both stream translators.
3. Add one mocked-upstream integration per behavior; assert usage and honest completion.
4. Coordinator updates `docs/idea/06-protocol-translation.md` in the same PR, alongside 05's SDK boundary clarification.

## Tests
- Baseline combined unit run: **1,111 pass, 0 fail**, 52 files; [`04-06-unit-tests.log`](04-06-unit-tests.log).
- `bin/test apps/api/test/unit/translate/responses.test.ts apps/api/test/unit/translate/matrix.test.ts apps/api/test/unit/translate/response-pairs.test.ts`.
- Relevant mocked-upstream `apps/api/test/integration/translate.test.ts` cases with the coordinator's test database; `bunx biome check <changed files>`.
- Full `bin/check` with `DATABASE_URL` and request-path `bin/bench` run once by coordinator; no live provider tests.

## Done when
- Parallel tool histories translate into a valid Chat assistant/tool grouping without changing call identities.
- Streamed and non-streamed refusals retain the same visible content.
- Same-dialect requests remain byte passthrough, and stream translation remains incremental.

## Coverage and limits
- Read all six request directions, registry pair reversal, Responses stream readers/emitters, Chat-to-Anthropic streaming, shared tool/usage/error contracts and existing translation tests/history.
- Exercised targeted request/stream failure inputs without network or database access.
- No exhaustive protocol-version conformance run, real-provider validation, all possible new multimodal variants, or performance measurement performed in this planning pass. No unsupported variant is counted as a defect without an explicit supported contract and code-level evidence.
