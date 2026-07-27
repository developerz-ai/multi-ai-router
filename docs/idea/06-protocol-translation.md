# Protocol translation

Status: **passthrough, all six HTTP translation pairs, and Agent-SDK re-synthesis are all
implemented** — every crossing between `anthropic`, `openai-chat`, and `openai-responses`, in
request, non-streaming response, and streaming form, plus the SDK path documented in its own
deliverable ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)). The SDK renders into
`anthropic` once, and every other ingress dialect is then served by the pair already in this table —
so a subscription Account reuses this page's translators rather than adding a row to it.
`services/dataplane/egress/mode.ts` is the seam the whole page lands on, and
`services/translate/registry.ts` is the one file a new pair is added to. Entities are defined in
[02-domain-model.md](02-domain-model.md); the driver that owns each egress dialect is in
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

| Path | Dialect | Operation |
|---|---|---|
| `POST /v1/messages` | Anthropic Messages (`anthropic`) | inference |
| `POST /v1/messages/count_tokens` | Anthropic Messages (`anthropic`) | count tokens — below |
| `POST /v1/chat/completions` | OpenAI Chat Completions (`openai-chat`) | inference |
| `POST /v1/responses` | OpenAI Responses (`openai-responses`) | inference |
| `POST /v1/embeddings` | OpenAI, dialect-neutral (`openai-chat` for the error shape) | embed — below |
| `GET /v1/models` | union of models reachable by the presenting key — [04-api-keys-and-access.md](04-api-keys-and-access.md) | — |
| `GET /v1/models/:id` | one model; `404` if the presenting key cannot reach it | — |

**Both OpenAI paths are first-class, and that is not redundancy.** `POST /v1/responses` is OpenAI's
current recommended primitive and where new clients are going; `POST /v1/chat/completions` is what the
installed base sends today. The router accepts both; neither is deprecated here.

## Counting tokens

`POST /v1/messages/count_tokens` is on the surface because **Claude Code calls it unprompted**,
before a turn, to decide when to compact its context. A router that 404s it is a router that client
half-works against.

It is an ordinary data-plane request: same router key, same scope intersection, same health
snapshot, same failover chain, one `UsageRecord` per attempt. Two things about it are not ordinary.

**It is passthrough or nothing.** A count is a statement about *one provider's tokenizer* for *one
prompt*, so the only honest answer is the number that provider returns. Neither alternative
survives contact with what a client does with it:

| Candidate | Answer | Why |
|---|---|---|
| Anthropic-dialect account (API key, or a compatible vendor's Anthropic surface) | **passthrough** to `{baseUrl}/v1/messages/count_tokens` | the provider's own number |
| `openai-chat` / `openai-responses` account | **not planned** | neither dialect exposes a counting endpoint, and a different tokenizer's count is not an answer to the question asked |
| Claude subscription (Agent SDK) | **not planned** | the SDK exposes no token-count call, and the router will never forge an `api.anthropic.com` request out of a subscription's credentials — [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) |

The refusal is **per candidate**, so a pool holding one Anthropic API key and four Claude
subscriptions still answers, off the one account that can. Only when *no* in-scope account can
count does it surface, and then as a **`503`** — the body was a valid Anthropic request and there is
no other ingress path to send it down, so what is missing is an Anthropic-dialect account, which
only the operator can add. That is the same reasoning that makes an unimplemented provider a `503`
rather than the `400` a missing *translator* gets. **The router never estimates.** A fabricated
integer is indistinguishable from a measured one at the client, which is the objection that already
forbids substituting a model. An Anthropic-compatible vendor that never implemented the endpoint
answers its own `404`, and that `404` is relayed unchanged.

That `503` says *no account can count*, and it must only be said when that is true. **A health
verdict on an account that could have counted outranks it** — see
[05-routing-and-failover.md](05-routing-and-failover.md#when-the-chain-is-empty). A pool holding one
Anthropic account that is cooling down and one OpenAI account that is fine has not run out of
counters; it has one, and it is back at 14:32. Answering `503` there would tell the operator to add
an account they already have, and hand the client a permanent-looking refusal for a condition a
clock fixes — the `cooling_down` versus `exhausted` conflation non-negotiable 7 forbids, one layer
above where it is usually made. So that request is a `429` with a `Retry-After` naming the cooling
account, and the operation gap is reported only when nothing held back could have answered it.

**Its `input_tokens` is never accounted, and it is never priced.** The response measures a prompt
that was never run, so the relay observes bytes and no tokens on this path: the `UsageRecord`
carries the request, the account, and the latency, with all four token columns at zero and **no
cost** — `cost_estimate` NULL, `cost_basis` `unknown`. Both halves are deliberate. Reading the
number would price a question as though it were a completion; recording a *zero* cost would be no
better, because zeroed counts against a model the price table knows come back as
`metered $0.000000`, which sums into a spend report as a completion that was free rather than as no
completion at all. Whether the model happens to be in the table may not change the shape of the
answer.

## Embeddings

`POST /v1/embeddings` is on the surface because **every RAG toolchain calls it beside its chat
traffic** — LangChain, LlamaIndex, and Continue.dev all index with it — and telling one of them to
use a second base URL for embeddings defeats the point of pooling credentials behind one endpoint.

It is an ordinary data-plane request: same router key, same scope intersection, same health
snapshot, same failover chain, one `UsageRecord` per attempt. Three things about it are its own.

**It is passthrough or nothing, and both OpenAI dialects are one family for it.** The body carries a
model and an `input` and nothing that distinguishes Chat Completions from Responses, so
`{baseUrl}/embeddings` is the same endpoint whichever chat surface an Account is pinned to.

| Candidate | Answer | Why |
|---|---|---|
| `openai-chat` **or** `openai-responses` account (an OpenAI key, or any OpenAI-compatible endpoint) | **passthrough** to `{baseUrl}/embeddings` | the body names no chat surface, so the Account's chat pin does not decide whether it can embed |
| Anthropic-dialect account | **not planned** | Anthropic publishes no embeddings API, so there is nothing below its base URL to address |
| Claude subscription (Agent SDK) | **not planned** | the SDK is a completion transport with no embeddings call, and the router will never forge an `api.anthropic.com` request out of a subscription's credentials — [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) |

Narrowing this to `openai-chat` alone would let an operator's choice of *chat* primitive silently
decide whether their key can embed, which is a routing rule nobody wrote down. Refusal is **per
candidate**, so a pool holding one OpenAI key and four Claude subscriptions still embeds, off the one
account that can — and when none can it surfaces as a **`503`**, for the same reason the token count
does: the body is a valid request, and what is missing is an account the operator would add. **The
router never substitutes.** A vector from a different model is not a lesser answer but a wrong one —
it compares as noise against every embedding already in the caller's index, which is the same
objection that forbids substituting a model. An OpenAI-compatible endpoint that serves chat but never
implemented embeddings answers its own `404`, and that `404` is relayed unchanged.

**Its `prompt_tokens` *are* accounted, as input alone.** Unlike a token count, an embedding spends
what it reports: `tokensIn` takes `prompt_tokens`, `tokensOut` is the zero it truthfully is, and
`total_tokens` is read nowhere — it restates a sum this router already holds in a column that means
something else. Embedding models are absent from the shipped price table, so the cost estimate is
`NULL` and the basis `unknown` (see [08-observability.md](08-observability.md#cost-estimation)) —
which is what every OpenAI-priced request reports today, and honest rather than a zero that reads as
free.

**Its ingress dialect is `openai-chat` for one purpose: the error shape.** The path is dialect-neutral
on the wire, and `openai-chat` is what a client calling `/v1/embeddings` expects a failure to look
like.

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
(`previous_response_id`, `store: true`, `include`, `conversation`, `prompt`, `background: true`, and
`reasoning` / `item_reference` input items) against non-Responses egress — `400`, the router holds no
conversation state; a structured-output constraint (`response_format`, `text.format`) on any
cross-dialect hop — `400`, the shape is a contract the caller will parse; and any request whose
required feature has no faithful target representation — `400`, naming the field.

Gemini is **not** an unsupported egress: the `gemini` driver speaks `openai-chat` over Google's
OpenAI-compatibility surface, so a Gemini account sits in the `OpenAI Chat Completions` column above
like any other. Only the **native Google GenAI protocol** is deferred — it would be a fourth
dialect, and a fourth row and column of pairs to write ([10-roadmap.md](10-roadmap.md)).

Statefulness is refused rather than approximated because the alternative is silent: a
`previous_response_id` the router cannot resolve would become a request carrying only the newest
turn, and the model would answer a conversation it was never shown. The refusal names the field, so
a client learns to send the whole transcript instead of receiving a confidently wrong answer. Note
that an **absent** `store` is not read as the provider's default — the caller stated nothing, and
refusing over a field nobody sent would make every ordinary Responses client unservable.

## How the translate mode is wired

The decision is one function — `resolveEgress` — and it takes passthrough whenever the dialects
match, so the registry is never consulted on the hot path. A pair with no entry is a rejection, not
a degraded conversion, which is what keeps "servable" meaning "a translator exists".

| Seam | Rule |
|---|---|
| Egress decision | `services/dataplane/egress/mode.ts`. Passthrough first; then a registry lookup; then a `400` naming the pair |
| Which conversion | `services/translate/registry.ts`, keyed by (ingress, egress). **Request and response run in opposite directions** — an `anthropic` client on an `openai-chat` account sends a body converted *toward* openai-chat and reads one converted *back* toward anthropic |
| Request body | Converted once per target dialect, lazily, and only when a translate candidate is actually reached. The **model** is re-applied per attempt, because two accounts of one dialect can carry different alias maps |
| Response | `relay-translate.ts`, a sibling of the passthrough relay and never a mode inside it, so no edit here can put a parser on the passthrough path |
| Upstream errors | Re-rendered into the **ingress** dialect on this path only. A passthrough error is relayed unchanged, because it is already the right shape and re-rendering it would drop fields the provider stated |

A chain may mix modes freely: an `anthropic` request over a pool holding one Anthropic account and
one OpenAI-compatible account plans a passthrough attempt and a translated one, in the order routing
chose. A body that cannot be converted **stops** the chain rather than walking it — the refusal is a
fact about the request, a bad request is bad at every account needing the same conversion, and the
`UsageRecord` records it as a client error rather than as an upstream failure.

Two asymmetries in what the relay reports, both deliberate. Token counting is fed the **upstream's**
bytes, because the `UsageRecord` stores the upstream's own numbers and not the translated ones.
Time-to-first-byte is measured on the **client's** first translated byte, because that is the claim
it exists to make. Both are observed after the enqueue, so neither can sit between a byte and the
client.

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
| Lossy | `is_error`, `strict`, Anthropic server-side/built-in tool types. `parallel_tool_calls` is **carried** between the two OpenAI dialects, which spell it identically, and dropped toward `anthropic`, which states the same idea as `tool_choice.disable_parallel_tool_use` — a field on a `tool_choice` the caller may not have sent at all |
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
| `content_block_delta` / `thinking_delta` | `delta.reasoning_content` / `delta.reasoning` — **read, never written**; see below | `response.reasoning_summary_text.delta` |
| `content_block_stop` | — (implied) | `response.content_part.done` / `response.output_item.done` |
| `message_delta` (stop reason, usage) | final chunk `finish_reason` + optional usage chunk | `response.completed` (carries usage) |
| `message_stop` | `data: [DONE]` | `response.completed` |
| `ping` | — (dropped) | — (dropped) |
| `error` | error chunk, then stream close | `response.failed` / `error` |

| | |
|---|---|
| Clean | Text deltas, tool-call argument deltas, terminal usage, stream termination. |
| Lossy | Block indices and boundaries are reconstructed, not preserved; a dialect with no "block" concept loses which block a delta belonged to. Reasoning text is dropped toward `openai-chat` and toward `anthropic`. Toward `anthropic`, `message_start` states a zeroed `usage`. Toward `openai-responses`, item ids (`msg_…`, `fc_…`, `rs_…`) are minted from the response id and the item's position, and a thinking or reasoning delta becomes a reasoning *summary* delta — the encrypted reasoning handle a native Responses upstream also emits cannot be synthesized and is not. |
| Rejected | Nothing at stream time — once bytes are on the wire the request fails honestly, it is never retranslated. |

**Reasoning text on `openai-chat` is read on the way in and never written on the way out.** OpenAI
publishes no reasoning-text field on a Chat Completions response — only the *count*,
`usage.completion_tokens_details.reasoning_tokens` — so the text a reasoning model produces travels
as a vendor extension, and the ecosystem never converged on one spelling. `reasoning_content` is
DeepSeek's, SGLang's, z.ai/GLM's, DashScope/Qwen's and xAI's; `reasoning` is OpenRouter's, Groq's and
Ollama's. The split is not even stable per vendor — vLLM emitted `reasoning_content`, flipped its
canonical name to `reasoning`, and spent a release emitting both. So **both names are read**,
`reasoning_content` wins when an upstream states both (the one server that does copies one into the
other, so they are the same string), and the text becomes a Responses reasoning item — that is
DeepSeek-R1, QwQ and GLM keeping their thinking across the seam instead of losing it.

Neither name is ever *emitted*: a dialect this router speaks toward a client is the one its vendor
published, and inventing an extension field into an answer is not translation.

Two reasoning shapes are **not read**, and are stated here rather than left to be discovered:

- **OpenRouter's `reasoning_details[]`** — a structured array carrying ids, formats and signed
  blocks. The flat `reasoning` string beside it is read and is enough to carry the text; the signed
  blocks are the same problem as an Anthropic `signature`, and nothing downstream can replay them.
- **Mistral's `content: [{"type":"thinking", …}]`** — magistral states reasoning as a *shape the
  answer takes*, not a field beside it, and `content` turns polymorphic mid-stream. Every reader here
  types `content` as a string, so an array-valued one reads as absent: on those models the answer
  text is dropped too, not merely the thinking. Reading it is a change to how `content` is parsed in
  every direction, not a field to add.

Toward `anthropic` the same text is dropped rather than turned into a `thinking` block, for a
harder reason than vocabulary: a client is entitled to replay an assistant turn verbatim on its next
request, and Anthropic refuses a `thinking` block whose `signature` this router cannot produce. An
unsigned block would answer this turn and break the next one.

**Toward `anthropic`, `message_start.usage` is zeroed and the real counts land on `message_delta`.**
`openai-chat` reports its token counts *last* — on a trailing chunk carrying no choices at all — so
nothing is known when the first event has to go out, and the field is required by the shape. This is
the one place a zero is written for an unknown count, and it is written because Anthropic itself puts
the authoritative numbers on `message_delta`, which is where a client already looks. The
`UsageRecord` is unaffected: it stores the upstream's own numbers, and a field the upstream never
sent stays null there.

**Toward `openai-responses` the translator keeps a copy of the text it has already sent, and that is
not buffering.** Every delta leaves the instant it arrives; what is retained is a copy, because the
dialect's own contract restates the finished text on `response.output_text.done` and the whole
response object on `response.completed` — the field a Responses client reads to get its final
answer. Emitting an empty terminal object would satisfy "hold only the state needed to reconstruct
boundaries" by breaking every client that uses the SDK's final-response accessor. When the model
stopped early the terminal event is `response.incomplete`, which is the same fact stated in the
field Responses reserves for it.

**A streamed tool call that cannot have a block yet waits for one; it is never dropped.** openai-chat
keys a streamed call by a `tool_calls[].index` it is free to revisit — a chunk carrying
`[{index:0},{index:1}]` followed by more arguments for index 0 is well-formed there, and vLLM,
SGLang, Fireworks and Together all emit it for parallel calls. Anthropic and Responses hold **one
open block or item at a time** and have no event that reopens a closed one, so the second call is
held until the live one closes and then given a block of its own, arguments and all. A reader that
kept only the block it opened last would answer with a `tool_use` whose `input` is truncated, under a
`stop_reason` saying the call was complete — a wrong tool invocation no client could detect. Holding
those fragments is not stream buffering: text is never touched, and the live call's deltas leave as
they arrive. The same rule covers an upstream that omits `index` altogether (LM Studio, Ollama): an
entry naming an `id` or a function name starts a call of its own, one naming neither continues the
call the entry before it addressed, and nothing is folded into whatever came last.

**A truncated stream is never given a synthesized ending.** If the upstream dies before its finish
reason, the translator emits no `message_delta`, no `message_stop`, and no `[DONE]` — the client
learns the truth from the abrupt close. Manufacturing a clean terminator would report a completion
that did not happen, on a request that cannot be retried because its bytes are already on the wire.
The reverse case is owed and is emitted: a stream that stated its finish reason but never sent the
terminator gets one, because the completion is whole and only its punctuation is missing.

**`[DONE]` is unconditional termination toward Anthropic, and never states a null `stop_reason`.**
Unlike the upstream connection simply closing, openai-chat's `[DONE]` sentinel is an explicit "I am
finished" — so `openai-chat-to-anthropic/stream.ts` always emits `message_delta` and `message_stop`
on it, even on the rare broken upstream that never sent a `finish_reason` chunk first. Anthropic
itself never states `stop_reason: null` on a `message_delta`, so that case falls back to the same
conservative `end_turn` an unrecognized reason would, rather than passing the absence through
literally.

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

One router-origin status is worth naming because it is easy to get wrong: a body over
`MAX_REQUEST_BODY_BYTES` renders as `413` — `request_too_large` in the Anthropic vocabulary,
`invalid_request_error` with `code: "request_too_large"` in the OpenAI one — and never as `400`. Both
are the caller's to fix, and the remedies are opposites: `400` says the request is malformed and
sends a developer hunting a bad field in a body that was merely long.

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
| OpenAI built-in tools (`web_search_preview`, `file_search`, `code_interpreter`, …) | `openai-responses` → any | unsupported; `400`. Served inside OpenAI's own inference, so nothing on the other side of the seam runs one |
| `stop` / `stop_sequences` | → `openai-responses` | no counterpart — the dialect has no stop parameter at all; **rejected** `400`, because a stop sequence decides where the answer ends and dropping it returns text past the delimiter the caller drew |
| `text.format` (structured output / JSON Schema) | `openai-responses` → any | `{"type":"text"}` passes; anything else is **rejected** `400`. A schema-constrained answer is a contract the caller will parse, and prose in its place is a different answer, not a degraded one |
| `response_format` (structured output / JSON mode) | `openai-chat` → any | `{"type":"text"}` passes; `json_object` and `json_schema` are **rejected** `400`. The same rule as `text.format` under openai-chat's older name for the same feature — including toward `openai-responses`, which *does* state it, because honoring it one direction and refusing it the other would make "servable" depend on which way the request pointed. Dropped instead, an OpenAI SDK `.parse()`, LangChain `withStructuredOutput()`, Instructor, or `generateObject` call gets prose and fails at its own `JSON.parse`, with nothing on the wire naming the cause |
| `conversation`, `prompt`, `background: true` | `openai-responses` → any | **rejected** `400`, the same class as `previous_response_id` under three later names: turns the provider would prepend, instruction text stored provider-side, and a queued response to poll by id. `background: false` passes |
| Responses `reasoning` output items | → `anthropic`, `openai-chat` | dropped. An Anthropic `thinking` block a client can replay needs a `signature` the router cannot produce, and openai-chat has no *published* field — the extension names are read from an upstream, never written toward a client |
| Anthropic `thinking` blocks | → `openai-responses` | carried as a reasoning **summary** item; the encrypted reasoning handle is not synthesized |
| openai-chat `reasoning_content` / `reasoning` | → `openai-responses` | **carried** as a reasoning **summary** item. Both spellings are read — DeepSeek's and OpenRouter's — and `reasoning_content` wins if an upstream states both. See [above](#streaming-sse-event-mapping) |
| openai-chat `reasoning_content` / `reasoning` | → `anthropic` | dropped. A synthesized `thinking` block carries no `signature`, and Anthropic refuses a replayed one that lacks it — the block would answer this turn and break the next |
| Anthropic `thinking` request parameter | → any OpenAI dialect | dropped. It is a **token budget** (`budget_tokens`), and no OpenAI dialect states one — only an effort word, which a budget cannot be turned into without inventing a number |
| `reasoning_effort` ⇄ `reasoning.effort` | `openai-chat` ⇄ `openai-responses` | **carried**, verbatim and both ways: OpenAI's own spec points both fields at one shared `ReasoningEffort` schema, so they are the same dial one level of nesting apart. The word is never validated against a list of ours — that set is `none \| minimal \| low \| medium \| high \| xhigh \| max` today, has grown twice past the four everyone remembers, and `none` means "do not think" rather than "invalid". Refusing a word the upstream accepts would be the router deciding how the model behaves |
| `reasoning.effort` | `openai-responses` → `anthropic` | dropped, and `reasoning_effort` from `openai-chat` with it. Anthropic's thinking budget is a token count, not an effort word, and inventing one would change what the caller pays for |
| `reasoning.summary` | `openai-responses` → any | dropped. It asks the *provider* to write a summary of its own reasoning, and no other dialect states the request |
| `parallel_tool_calls` | `openai-chat` ⇄ `openai-responses` | **carried**, both ways: both dialects spell it identically. An absent field stays absent — `false` is the value that changes behaviour, so defaulting one in would be a decision the caller never made |
| `input_image` naming only a `file_id` | `openai-responses` → any | rejected `400`: a stored file is provider-side state this router cannot resolve into bytes |
| `max_tokens` / `max_completion_tokens` | → `openai-chat` | not lossy, but **not one name either** — emitted under whichever of the two the selected Account accepts. See [The output ceiling](#the-output-ceiling-one-field-two-names) |
| Responses item ids | → `openai-responses` | minted by the router from the response id and the item's position — deterministic, but not the provider's own |
| Beta headers (`anthropic-beta`) | → non-Anthropic, and on the Agent-SDK path | dropped |
| `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`, `n`, `logprobs`, penalties | → `agent-sdk` | **accepted and silently inert** — `query()` has no equivalent for any of them, so a value the caller set has no effect on the request. `reasoning_effort` is the exception, mapped onto the SDK's effort scale (`low`…`max`; OpenAI's `minimal` has no target) |

**Silently dropping a parameter the caller set is a correctness trap, so the router does not stay
quiet about it.** Every inert sampling field a request carried is surfaced by name, so a caller can
tell "ignored" from "honored" instead of being answered as though it had been applied. Which surface
carries it — a response-level warning field, a header, a logged and counted event, or several — is
**DEFERRED**; that it is surfaced is not. It also compounds: current Anthropic models reject
`temperature` / `top_p` / `top_k` outright, so the same field is a `400` on the HTTP path and a
silent no-op here.

## The output ceiling: one field, two names

`openai-chat` has one output ceiling and two names for it, and **no upstream accepts both**. OpenAI
renamed `max_tokens` to `max_completion_tokens`, marked the old name `deprecated` in its own
published schema, and made it *incompatible* with the reasoning models — `o1`, `o3`, `o4-mini`,
`gpt-5` answer it with `400 Unsupported parameter`. Most compatible vendors never followed: five of
the providers this router drives (DeepSeek, Mistral, Together, Ollama, z.ai) state no
`max_completion_tokens` at all.

Sending the wrong one fails in two different ways, and the quiet one is worse:

- the **new** name at a vendor that does not know it — Ollama drops the field and generates to its
  own default. The ceiling the caller set disappears with no error anyone can see. Mistral's schema
  forbids unknown fields outright, so the same body is a hard refusal there;
- the **old** name at OpenAI — a `400` on every reasoning model it sells, which is what an Anthropic
  or Responses client reaching an `openai-api` account used to get on every single request.

So the name is a fact about the **provider**, declared once in its driver (`chatCeiling` on the
surface, defaulting to `max_tokens` — the name every compatible vendor states) and resolved per
candidate exactly like the model is. It is never guessed from a model name: `openai/o3` reached
through OpenRouter is addressed the way OpenRouter states, not the way the model's own vendor does.
Vendors that accept **both** and merely deprecate the old one (Groq, xAI, Cerebras, Kimi, MiniMax)
stay on `max_tokens`; the declaration is where they move the day one of them removes it.

Two consequences worth stating out loud:

- **exactly one name is ever emitted.** Sending both is not the safe middle — OpenAI refuses
  `max_tokens` whether or not the new name sits beside it, so a body carrying both fails on
  precisely the models the new name exists for;
- **the cached conversion is keyed by target *shape*, not target dialect**
  (`services/dataplane/translate-body.ts`). Two `openai-chat` accounts in one chain can disagree, so
  a failover across them converts twice and hands each the name it reads. A chain of accounts that
  agree — the ordinary case — still converts once.

None of this touches a **passthrough**. A client that speaks `openai-chat` to an `openai-chat`
account sends bytes the router does not open, under whichever name it chose; that request is between
the client and its provider, and the error it gets back is honest and actionable
([The core rule](#the-core-rule)). Inbound, both names are read wherever the router converts *away*
from `openai-chat`, and `max_completion_tokens` wins when a body carries both.

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

**Two sides of one map, and `GET /v1/models` sits between them.** An Account's `supportedModels`
is stated **upstream-side** — the names the provider itself answers to, the side the alias map points
*at*, and the side a provider's own listing returns — while the alias map's *keys* are what a client
sends. Support is therefore judged **after** the rename: an Account declaring `glm-4.7` and mapping
`sonnet → glm-4.7` serves both names. The listing publishes exactly the requested-side names for
which that judgement is yes, derived from the same function (`advertisedModels`, next to
`resolveModel`) rather than restated. That is not tidiness — a naive union of the two fields is wrong
in both directions: an alias onto a model the Account does not serve would be advertised and then
filtered out as `model-unsupported` (a listing promising a `503`), and a declared name whose own
alias entry points somewhere unserved is not requestable under that name at all.

An Account declaring **nothing** serves everything: unknown is passthrough, not exclusion. It
contributes no enumerable name beyond its alias keys, so a deployment of only such Accounts lists
nothing rather than inventing a catalog it cannot stand behind — which is why the operator is given
`POST /api/admin/accounts/:id/models/discover`, one free `GET` at the provider's own listing, to fill
the declaration in.

## Performance rules (hard requirements, not preferences)

The router is in the hot path of every request every developer and every agent makes. These are
requirements, not preferences — a violation is a bug, not a tuning opportunity. The budget itself
(**< 5 ms added p99, zero added time-to-first-token**) is in [01-architecture.md](01-architecture.md);
`router_overhead_seconds` in [08-observability.md](08-observability.md) is what proves it.

| Rule | Requirement |
|---|---|
| **Never buffer a stream** | Upstream bytes are relayed to the client as they arrive. No accumulate-then-forward, no re-chunking, and **no waiting for a complete SSE event before flushing**. Absolute on the passthrough path; per emitted event on the translation path |
| **The passthrough body is opaque** | On same-dialect egress the request body is bytes. The router extracts exactly two things from it — the **model name** and the **session key** — preferring incremental extraction over materializing the JSON, and forwards the rest untouched |
| **Every string extracted is bounded** | Incremental means nothing if the scanner still accumulates a value it will discard: a top-level `system` prompt is a string and is routinely kilobytes, so it is scanned past rather than collected. The only strings ever accumulated are a top-level *key* and the `model` value, both capped at 256 bytes. Over that cap the model name is refused with `400` — never truncated, which would be a substituted model |
| **Full parse only on demand** | A complete parse and re-serialization happens **only** when cross-dialect translation is genuinely required. "We might need it later" is not a reason to parse, and Zod validates the router's own boundary (auth, routing inputs), never a body we are not rewriting |
| **Translation is incremental** | One upstream event in, zero or more client events out, flushed immediately. The translator holds only the state needed to reconstruct block boundaries |
| **The Agent-SDK path is the labeled exception** | A subprocess per request is inherently heavier than an HTTP hop. Document the cost; do not pretend the budget applies uniformly ([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)) |

## Design rules

| Rule | Meaning |
|---|---|
| Pure function pairs | `(request in) → request out` and `(event in) → events out`. No clock, no store, no network, no logger. A value a translator cannot compute without one — the `created` stamp, the id used when the upstream names none — is **injected**, so the same recorded input converts to the same bytes in a test as it does on the wire. |
| Fully unit-testable | Every pair is exercised with fixtures alone. Streaming is tested by feeding a recorded event sequence and asserting the emitted sequence. |
| One module per dialect pair | `services/translate/<from>-to-<to>/`, request and stream translators split. A pair is added without touching the others (Open/Closed). Each pair owns its own *reading* of the wire — its schemas are local, so a field added for one pair cannot change what another accepts |
| One emitter per target dialect | The event sequence a dialect's clients rely on is a fact about that dialect, not about the pair producing it, so it is written once (`shared/anthropic-stream.ts`, `shared/responses-stream.ts`). Two copies could disagree, and a client would then be able to tell from the stream which ingress path served it — the one thing a translator exists to hide. `openai-chat` needs no such module: its stream carries no block or item structure, so there is no ordering to disagree about |
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
