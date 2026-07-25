# Protocol translation

Status: **the passthrough half is implemented**; the ingress surface, the model-alias rule, and the
byte-for-byte relay all work. **Cross-dialect translation is not built** — a request that would need
it is refused with a `400` naming the reason, before any upstream call, in
`services/dataplane/egress/mode.ts`. That module is the seam this whole page lands on. Entities are
defined in [02-domain-model.md](02-domain-model.md); the driver that owns each egress dialect is in
[03-providers.md](03-providers.md).

## The core rule

> **Same-dialect is byte passthrough.** Headers are swapped, the body is untouched, the stream is
> forwarded verbatim.

Passthrough is always preferred, because it has zero translation loss: a new upstream feature, a new
content block type, a beta flag we have never heard of all survive a passthrough, and none of them
survive a translation we did not write. There are exactly three egress modes, and the router takes the
leftmost one that applies.

| | **Passthrough**<br>ingress dialect == egress | **Translation**<br>HTTP driver, dialects differ | **Agent-SDK re-synthesis**<br>Claude *subscription* accounts |
|---|---|---|---|
| Request body | forwarded unchanged | rebuilt field by field | rebuilt into an SDK `query()` call — no upstream HTTP request exists |
| Headers | router key stripped, upstream credential + provider headers injected | same | none; the subprocess authenticates from its own `CLAUDE_CONFIG_DIR` |
| Streaming | relayed byte for byte | re-emitted event by event | **synthesized** from SDK stream messages |
| Unknown fields | survive | dropped, or the request is rejected | dropped — the SDK's surface is the ceiling |
| Failure mode | upstream's own error, passed through | `400` before the call if it cannot be translated faithfully | SDK error mapped into the ingress dialect's error shape |

## Ingress surface

| Path | Dialect |
|---|---|
| `POST /v1/messages` | Anthropic Messages (`anthropic`) |
| `POST /v1/chat/completions` | OpenAI Chat Completions (`openai-chat`) |
| `POST /v1/responses` | OpenAI Responses (`openai-responses`) |
| `GET /v1/models` | union of models reachable by the presenting key — [04-api-keys-and-access.md](04-api-keys-and-access.md) |

**Both OpenAI paths are first-class, and that is not redundancy.** `POST /v1/responses` is OpenAI's
current recommended primitive and where new clients are going; `POST /v1/chat/completions` is what the
installed base sends today. The router accepts both; neither is deprecated here.

## Translation matrix

Ingress dialect (rows) × the selected Account's native egress dialect (columns). The account is
chosen by [05-routing-and-failover.md](05-routing-and-failover.md) *before* this decision is made.

| Ingress ↓ / Egress → | `anthropic` | `openai-chat` | `openai-responses` | `agent-sdk` |
|---|---|---|---|---|
| **Anthropic Messages** | **passthrough** | translate | translate | re-synthesize |
| **OpenAI Chat Completions** | translate | **passthrough** | translate | re-synthesize |
| **OpenAI Responses** | translate | translate (downgrade) | **passthrough** | re-synthesize |

Legend: **passthrough** = bytes untouched · translate = pure conversion pair, lossy where the
"Known lossy edges" table says so · downgrade = the richer dialect is expressed in the poorer one ·
re-synthesize = rendered from Agent SDK output, never proxied (below).

**Unsupported**, returning `4xx` rather than a degraded call: a stateful Responses request
(`previous_response_id`, `store: true`, reasoning items) against non-Responses egress — `400`, the
router holds no conversation state; and any request whose required feature has no faithful target
representation — `400`, naming the field. Native Google GenAI egress is **DEFERRED**; Gemini goes
through an OpenAI-compatible layer in v1.

## Agent-SDK egress (Claude subscriptions)

Claude Max/Pro subscription accounts take **no HTTP path at all**: requests go through
`@anthropic-ai/claude-agent-sdk`'s `query()`, launched against that Account's own `CLAUDE_CONFIG_DIR`,
with no subscription token extracted and no request forged. Rationale and mechanics live in
[11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md); the wire consequence is what matters here —
**there is nothing to proxy.** The SDK yields its own message objects and the router *re-synthesizes*
a compliant Anthropic (or OpenAI) response from them, so even `POST /v1/messages` → a Claude sub,
nominally same-dialect, is a re-synthesis and not a passthrough. Anthropic API-key accounts keep the
ordinary HTTP driver. Where fidelity is lost, said plainly:

| Loss | Why |
|---|---|
| Byte-for-byte parity | The response is constructed by us, not relayed. Ids, block indices, and event boundaries are ours |
| Unknown / new upstream fields | What the SDK does not surface cannot be re-synthesized. Passthrough's "new features survive for free" property does **not** hold here |
| **Sampling parameters** — `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`, `n`, penalties | `query()` exposes no equivalent, so they are accepted and **silently inert**. Listed per field under [Known lossy edges](#known-lossy-edges), where the surfacing rule also lives |
| `anthropic-beta` opt-ins and `metadata` | The SDK owns the request it makes; only a filtered subset passes through |
| Exact `usage` decomposition and `cache_control` hints | Caching is the SDK's to control; cache-creation vs. cache-read attribution is as coarse as the SDK reports it |

**Tool calls are forwarded to the client; the router never executes one.** The SDK is invoked in
passthrough-only tool mode — its host-executing built-ins (`bash`, `read`, `write`, `edit`, `glob`,
`grep`) are disabled by an explicit allowlist naming them, so a captured call leaves as an ordinary
`tool_use` block and the client executes it exactly as on the HTTP path. That is the correct router
behavior on its own terms (the client owns the user's filesystem and consent), and it is a hard
security boundary: executing them here would be remote code execution on the router host for any key
holder — [07-security.md](07-security.md). Anthropic *server* tools are not reachable at all; the SDK
cannot emit `server_tool_use`, so such requests are rejected `400` naming the field and the types are
not advertised in `GET /v1/models`.

The subprocess is also launched with `settingSources: []` explicitly set. That keeps the router
host's own `CLAUDE.md` and user settings out of the system prompt — a cross-tenant leak, and a
wire-visible one, since ambient host configuration would otherwise change the request the SDK makes.
It is an isolation guarantee, not tidiness; do not remove it as dead code.

Compensating: stop reasons, tool-use blocks, text deltas, and token usage **are** synthesized to the
same contract as the HTTP path, so a client cannot tell from the response shape which path served it.
Quota signals arrive as SDK `rate_limit_event` messages rather than response headers —
[08-observability.md](08-observability.md).

## What translation must cover

### System prompts

| | |
|---|---|
| Clean | Anthropic `system` (string or text-block array) ⇄ OpenAI leading `role: "system"` / `"developer"` message. |
| Lossy | `cache_control` on a system block is dropped when the target has no equivalent. Multiple system blocks are concatenated with newlines in one direction and cannot be split back. |
| Rejected | Nothing. A system prompt always has a target representation. |

### Message roles and content blocks

| | |
|---|---|
| Clean | `user` / `assistant` roles; text blocks; `image` blocks with a base64 `source` ⇄ OpenAI `image_url` with a `data:` URI; a remote-URL `image_url` ⇄ Anthropic's `source: {type:"url"}`; `tool_result` ⇄ `role: "tool"` message keyed by `tool_call_id`. |
| Lossy | `detail: "low"/"high"` is dropped. Anthropic `thinking` / `redacted_thinking` blocks have no OpenAI Chat counterpart and are dropped. |
| Rejected | Interleaved multi-part `tool_result` content the target cannot express; audio and file parts; an image source that is neither a base64 `data:` URI nor http(s); Anthropic `document` blocks. |

A remote URL is **never fetched and inlined**. A translator is a pure function, and reaching an
arbitrary URL from inside one puts a network call — and an SSRF surface — on the request path;
Anthropic's own `url` image source carries the reference instead, so the fetch never has to happen.
Anthropic `document` blocks are **rejected, not dropped**: a document is content the caller sent,
and losing it quietly returns an answer to a question that was never asked.

Anthropic requires strict `user`/`assistant` alternation; OpenAI does not. Translating toward
Anthropic merges consecutive same-role messages rather than reordering them. Merging concatenates
content the model was going to read in that order anyway; reordering would change what it was told.
Every `role:"tool"` message becomes a `tool_result` block on a **user** turn, so a run of them
merges into one turn — which is exactly the shape Anthropic expects. Toward OpenAI the same merge
runs for plain-content turns only: alternation is not required there, but several
OpenAI-compatible upstreams reject two adjacent `user` messages that OpenAI itself accepts. A turn
carrying `tool_calls` or a `tool_call_id` never merges — it is keyed to one specific call.

### Tool and function calling

| Direction | Shape |
|---|---|
| Anthropic → OpenAI | `tools[].{name, description, input_schema}` → `tools[].function.{name, description, parameters}`; `tool_choice: {type:"auto"\|"any"\|"tool", name}` → `"auto"\|"required"\|{type:"function",function:{name}}` |
| OpenAI → Anthropic | inverse; `strict: true` has no Anthropic equivalent and is dropped |
| Calls | Anthropic `tool_use` block `{id, name, input}` ⇄ OpenAI `tool_calls[].{id, function.{name, arguments}}` — `input` is an object, `arguments` is a **JSON string**; both directions parse/serialize |
| Results | Anthropic `tool_result` `{tool_use_id, content, is_error}` ⇄ one `role:"tool"` message per call; `is_error` has no OpenAI field and is folded into the result text |
| Clean | Name, description, JSON Schema parameters, call ids, parallel calls (Anthropic emits several `tool_use` blocks; OpenAI emits several `tool_calls` entries). Ids are preserved verbatim; ordering across blocks/entries is reconstructed and may differ |
| Lossy | `is_error`, `strict`, `parallel_tool_calls: false`, Anthropic server-side/built-in tool types |
| Rejected | A tool whose schema is not a valid JSON Schema object type; a `tool_result` with no matching call id in the transcript |

### Streaming SSE event mapping

The Anthropic side is the verified event order, and translating *toward* Anthropic must emit exactly
it. Note that `stop_reason` and `usage.output_tokens` arrive on **`message_delta`** — a translator
that waits for them on `message_stop` emits a finish with no reason and no token count.

```
message_start → content_block_start → content_block_delta* → content_block_stop
              → message_delta (carries stop_reason and usage.output_tokens) → message_stop
```

| Anthropic | OpenAI Chat Completions | OpenAI Responses |
|---|---|---|
| `message_start` | first `chat.completion.chunk` with `delta.role` | `response.created` + `response.in_progress` |
| `content_block_start` (text) | — (implied) | `response.output_item.added` + `response.content_part.added` |
| `content_block_delta` / `text_delta` | `chunk.choices[].delta.content` | `response.output_text.delta` |
| `content_block_start` (`tool_use`) | `delta.tool_calls[].{index,id,function.name}` | `response.output_item.added` (function call) |
| `content_block_delta` / `input_json_delta` | `delta.tool_calls[].function.arguments` | `response.function_call_arguments.delta` |
| `content_block_delta` / `thinking_delta` | no counterpart — dropped | `response.reasoning_summary_text.delta` |
| `content_block_stop` | — (implied) | `response.content_part.done` / `response.output_item.done` |
| `message_delta` (stop reason, usage) | final chunk `finish_reason` + optional usage chunk | `response.completed` (carries usage) |
| `message_stop` | `data: [DONE]` | `response.completed` |
| `ping` | — (dropped) | — (dropped) |
| `error` | error chunk, then stream close | `response.failed` / `error` |

| | |
|---|---|
| Clean | Text deltas, tool-call argument deltas, terminal usage, stream termination. |
| Lossy | Block indices and boundaries are reconstructed, not preserved; a dialect with no "block" concept loses which block a delta belonged to. Thinking deltas are dropped toward `openai-chat`. Toward `anthropic`, `message_start` states a zeroed `usage`. |
| Rejected | Nothing at stream time — once bytes are on the wire the request fails honestly, it is never retranslated. |

**Toward `anthropic`, `message_start.usage` is zeroed and the real counts land on `message_delta`.**
`openai-chat` reports its token counts *last* — on a trailing chunk carrying no choices at all — so
nothing is known when the first event has to go out, and the field is required by the shape. This is
the one place a zero is written for an unknown count, and it is written because Anthropic itself puts
the authoritative numbers on `message_delta`, which is where a client already looks. The
`UsageRecord` is unaffected: it stores the upstream's own numbers, and a field the upstream never
sent stays null there.

**A truncated stream is never given a synthesized ending.** If the upstream dies before its finish
reason, the translator emits no `message_delta`, no `message_stop`, and no `[DONE]` — the client
learns the truth from the abrupt close. Manufacturing a clean terminator would report a completion
that did not happen, on a request that cannot be retried because its bytes are already on the wire.
The reverse case is owed and is emitted: a stream that stated its finish reason but never sent the
terminator gets one, because the completion is whole and only its punctuation is missing.

### Stop and finish reasons

The Anthropic `stop_reason` set is closed and complete: `end_turn`, `max_tokens`, `stop_sequence`,
`tool_use`, `pause_turn`, `refusal`. Every one has a row below; an unrecognized value is a provider
change, logged and mapped conservatively to `end_turn` / `stop`, never dropped silently.

| Anthropic `stop_reason` | OpenAI `finish_reason` | Responses | Note |
|---|---|---|---|
| `end_turn` | `stop` | `status: "completed"` | clean, both ways |
| `max_tokens` | `length` | `incomplete_details.reason: "max_output_tokens"` | clean, both ways |
| `tool_use` | `tool_calls` | `status: "completed"` with a function-call output item | clean, both ways |
| `stop_sequence` | `stop` | `status: "completed"` | lossy → OpenAI: *which* sequence matched (`stop_sequence` field) is lost |
| — | `content_filter` | `incomplete_details.reason: "content_filter"` | lossy → Anthropic: mapped to `end_turn`, the refusal reason is lost |
| `pause_turn`, `refusal` | `stop` | `status: "completed"` | lossy → OpenAI |
| — | `function_call` | — | OpenAI's superseded single-function form; still emitted by some compatible upstreams, so it is read as `tool_use` rather than falling to `end_turn` and reporting a tool call as text |

Because a translator is a pure function with no logger behind it, the mapping **returns** the
unrecognized value alongside the conservative one; the caller — which holds the request id — is what
logs it. One line per provider change, none in steady state.

### Usage and token fields

Anthropic reports exactly four fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`.

| Anthropic | OpenAI Chat | Responses |
|---|---|---|
| `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` | `prompt_tokens` | `input_tokens` |
| `output_tokens` | `completion_tokens` | `output_tokens` |
| (sum) | `total_tokens` | `total_tokens` |
| `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| `cache_creation_input_tokens` | no field of its own — folded into `prompt_tokens` | same |
| no counterpart | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |

> **Total prompt size is the sum of all three input fields** — `input_tokens` +
> `cache_creation_input_tokens` + `cache_read_input_tokens`. `input_tokens` alone counts only the
> uncached remainder, so a dashboard reporting it by itself under-reports cached traffic badly, and
> the better the caching the worse the error. Same rule in [08-observability.md](08-observability.md).

**The prompt row is a conversion, not a rename**, and that is what the note above forces. Anthropic's
`input_tokens` is the uncached remainder; OpenAI's `prompt_tokens` is the whole prompt with
`cached_tokens` a subset of it. So the crossing sums the three input fields toward `openai-chat`, and
subtracts `cached_tokens` back out toward `anthropic`. Mapping the two field names onto each other
verbatim would report a cache-heavy request as a handful of tokens and break every client-side cost
estimate built on it. `cache_creation_input_tokens` is never invented in the other direction:
`openai-chat` reports cache reads only, and guessing the write is the one number an operator reads to
decide whether caching is paying for itself.

The **`UsageRecord` stores the upstream's own numbers**, not the translated ones. OpenAI streams omit
usage unless `stream_options.include_usage` is set; translating an Anthropic stream toward
`openai-chat` always emits it, and a missing field is recorded as null, never as zero — zero is a
measurement, and reporting it for a field the upstream never sent invents data.

### Error shapes

| Dialect | Shape |
|---|---|
| Anthropic | `{"type":"error","error":{"type":"invalid_request_error","message":"…"}}` |
| OpenAI | `{"error":{"message":"…","type":"invalid_request_error","param":null,"code":null}}` |

Rules: an upstream error is translated into the **ingress** dialect, so a Claude Code client always
receives an Anthropic-shaped error even when the account that failed was an OpenAI one — or an
Agent-SDK one. Router-origin errors (`NoHealthyAccountError`, `QuotaExhaustedError`, …) use the same
shape with a stable HTTP status. `param` and `code` are best-effort and may be null. No error body
ever carries credential material or the identity of the account that failed.

The rendered `type` is derived from the **HTTP status**, not copied from the upstream body. The
vocabularies are per-dialect — `invalid_request_error` is spelled the same in both, `overloaded_error`
and `server_error` are not — and a foreign type name in the wrong dialect is a lie a client will
branch on; the status is the one signal both dialects agree on. The upstream's own type survives in
the best-effort `code` field where the target shape has room for it. The upstream's `message` is
passed through, because it is the only diagnostic the caller has, but it is **scrubbed with the log
redactor and length-bounded** first: an upstream is free to quote a key back at us or answer with a
whole HTML page, and this body is a client-facing surface. The HTTP status itself is not remapped
here — whether a provider's `401` becomes something else to the client is a routing decision, made
before a body needs rendering.

## Known lossy edges

Be suspicious of any cell not listed here — if it is not documented, it is not translated.

| Feature | Direction | What happens |
|---|---|---|
| Anthropic `thinking` / `redacted_thinking` blocks | → `openai-chat` | dropped from the response; not re-sent on the next turn |
| `cache_control` hints | → any non-Anthropic | dropped; the upstream simply does not cache. Prompt caching is per-account, which is why routing is sticky |
| OpenAI `logprobs` / `top_logprobs` | → `anthropic` | no counterpart; rejected with `400` rather than silently ignored |
| OpenAI `n > 1` | → `anthropic` | no counterpart; rejected with `400` |
| `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias` | → `anthropic` | dropped (documented, not rejected — they are hints, not contracts) |
| Anthropic `top_k` | → OpenAI | dropped |
| Remote-URL images | → `anthropic` | carried as Anthropic's `source: {type:"url"}`, never fetched — see [above](#message-roles-and-content-blocks). `detail: "low"/"high"` is dropped |
| Absent `max_tokens` | → `anthropic` | Anthropic requires one and OpenAI's is optional, so a configured default is supplied. Not a constant in a branch: the value is a parameter of the translator, defaulted generously, because a low ceiling would truncate an answer the caller never asked to truncate |
| Anthropic server-side tools (web search, code execution) | → OpenAI | unsupported; `400` |
| Beta headers (`anthropic-beta`) | → non-Anthropic, and on the Agent-SDK path | dropped |
| `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`, `n`, `logprobs`, penalties | → `agent-sdk` | **accepted and silently inert** — `query()` has no equivalent for any of them, so a value the caller set has no effect on the request. `reasoning_effort` is the exception, mapped onto the SDK's effort scale (`low`…`max`; OpenAI's `minimal` has no target) |

**Silently dropping a parameter the caller set is a correctness trap, so the router does not stay
quiet about it.** Every inert sampling field a request carried is surfaced by name, so a caller can
tell "ignored" from "honored" instead of being answered as though it had been applied. Which surface
carries it — a response-level warning field, a header, a logged and counted event, or several — is
**DEFERRED**; that it is surfaced is not. It also compounds: current Anthropic models reject
`temperature` / `top_p` / `top_k` outright, so the same field is a `400` on the HTTP path and a
silent no-op here.

## Model names

**Model names pass through unchanged.** The router never substitutes a model on its own — the central
invariant from [00-overview.md](00-overview.md): the client picks the model, the router picks the
account. Anthropic model ids carry no date suffix (`claude-opus-5`, `claude-sonnet-5`, …); the router
neither adds nor strips one. The single exception is the selected **Account's alias map**, an
operator-authored `requested name → upstream model id` table (z.ai wants `glm-4.7`, Kimi wants `k3`; a
client may legitimately send `sonnet`). Per Account, applied by the driver, identity on a miss,
outbound-only — the `UsageRecord` stores both names and `GET /v1/models` reports requested-side names.
An Account that cannot serve the requested model is filtered *out* of the candidate set, never
silently swapped.

## Performance rules (hard requirements, not preferences)

The router is in the hot path of every request every developer and every agent makes. These are
requirements, not preferences — a violation is a bug, not a tuning opportunity. The budget itself
(**< 5 ms added p99, zero added time-to-first-token**) is in [01-architecture.md](01-architecture.md);
`router_overhead_seconds` in [08-observability.md](08-observability.md) is what proves it.

| Rule | Requirement |
|---|---|
| **Never buffer a stream** | Upstream bytes are relayed to the client as they arrive. No accumulate-then-forward, no re-chunking, and **no waiting for a complete SSE event before flushing**. Absolute on the passthrough path; per emitted event on the translation path |
| **The passthrough body is opaque** | On same-dialect egress the request body is bytes. The router extracts exactly two things from it — the **model name** and the **session key** — preferring incremental extraction over materializing the JSON, and forwards the rest untouched |
| **Full parse only on demand** | A complete parse and re-serialization happens **only** when cross-dialect translation is genuinely required. "We might need it later" is not a reason to parse, and Zod validates the router's own boundary (auth, routing inputs), never a body we are not rewriting |
| **Translation is incremental** | One upstream event in, zero or more client events out, flushed immediately. The translator holds only the state needed to reconstruct block boundaries |
| **The Agent-SDK path is the labeled exception** | A subprocess per request is inherently heavier than an HTTP hop. Document the cost; do not pretend the budget applies uniformly ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)) |

## Design rules

| Rule | Meaning |
|---|---|
| Pure function pairs | `(request in) → request out` and `(event in) → events out`. No clock, no store, no network, no logger. |
| Fully unit-testable | Every pair is exercised with fixtures alone. Streaming is tested by feeding a recorded event sequence and asserting the emitted sequence. |
| One module per dialect pair | `services/translate/<from>-to-<to>/`, request and stream translators split. A pair is added without touching the others (Open/Closed). |
| Passthrough is not a translator | It is a relay in the transport layer. It has no per-dialect module and no schema knowledge. |
| Fail loud, never degrade | A request that cannot be translated faithfully returns a clear `4xx` naming the offending field, before any upstream call. Silently dropping a *contract* field is a bug; dropping a documented *hint* is listed above. |
| One direction at a time | Each translator is written and tested per direction. "Round-trips" are not assumed to be lossless and are not asserted. |

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Where the translation decision sits in the request lifecycle |
| [03-providers.md](03-providers.md) | Which dialect each provider speaks natively |
| [05-routing-and-failover.md](05-routing-and-failover.md) | How the account — and therefore the egress dialect — is chosen |
| [07-security.md](07-security.md) | What may never appear in a translated error body |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | The Agent-SDK path in full: why, mechanics, per-Account config dirs |
