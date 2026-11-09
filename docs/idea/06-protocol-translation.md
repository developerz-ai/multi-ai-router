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

> **Successful same-dialect traffic is byte passthrough.** Protocol headers are allowlisted,
> the request body is untouched except an explicit model alias, and successful streams are forwarded verbatim.
> Failure bodies are bounded and scrubbed before they can reach a client or log.

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
| `GET /v1/catalog` | the same models, with context window, price, and pooling depth — this router's own shape | — |
| `GET /v1/providers` | the upstreams the presenting key can reach, and how many accounts of each can serve now | — |

**`/v1/catalog` is a separate path rather than more fields on `/v1/models`, deliberately.**
`/v1/models` is a *wire contract*: an OpenAI or Anthropic client parses it with a generated SDK, and
the router's job there is to answer in the shape those clients expect and nothing more. The catalog
is the router's own listing, so it can say things neither of those shapes has a place for — what it
costs, how many accounts stand behind the name, and where a size came from.

**`/v1/models` does say how big each model is**, because both ecosystems have a place for it and
clients read it. Served from the warm model catalog, never a query on the request path; per field,
the first in-scope account that states a number wins over one that does not. Anthropic shape:
`max_input_tokens` and `max_tokens` — Anthropic's own `ModelInfo` fields, always present, `null`
when unknown. OpenAI shape: OpenAI's `Model` has no size field, so the OpenAI-compatible convention —
`context_length` (OpenRouter, Together) and `max_completion_tokens` — **absent when unknown**,
because an undocumented field is read as `optional(number)` and a `null` would fail it. What each
provider's listing states, and what Claude Code reads:
[03-providers.md](03-providers.md#model-sizes--what-each-listing-states).

It is shaped after an aggregator's models endpoint in *what it answers*, not byte-for-byte in how it
spells it, and the difference is deliberate. Copying that shape exactly would mean publishing
per-token decimal strings, a single "top provider" this router chooses per request, and architecture
fields nothing here can verify — a listing that looks authoritative while being unable to stand
behind half of it. So: per-million-token prices, the unit every price in this system already uses; a
provider *list* rather than a winner, because pooling is the product; and no field this router cannot
source. `null` means **unknown** in every numeric field — never zero, never unlimited.

**`pricing`** is `{ currency: "USD", input_per_mtok, output_per_mtok, cache_read_per_mtok,
cache_write_per_mtok }` from the shipped tables (`services/cost/tables/`) or the operator's override,
`null` where neither has one. A model priced in tiers adds **`long_context`** — the same four numbers
plus `from_prompt_tokens` — the card that replaces the standard one, every token direction, once a
request's total prompt (input + cache read + cache write) reaches that size; absent means one price
whatever the prompt. These are the numbers the router's own usage records are priced by, so a client
pricing its own usage from them gets the router's answer.

**`reasoning`** is the upstream listing's own `{ supported, toggle?, effort? }` for the model, read
into `model_catalog` by the hourly sweep and absent where no serving account's listing stated one.
A driver may read its listing off another of its surfaces (`ProviderModelListing.dialect`):
OpenCode Go's anthropic `/v1/models` names ids only, so a Go seat serving on that surface still
reads `/openai/v1/models`, which carries `limit.context`, `limit.output` and
`capabilities.reasoning`. Through 2.51.0 it read its own surface, and prod held 60 Go rows with no
size and no `reasoning` (2026-11-07).

**`/v1/catalog` sizes are the smallest known across the accounts behind a name.** Selection may
send a request to any of them, so the size a client can size a prompt against is the one every
account can take: `context_length` and `max_output_tokens` are each the minimum *known* value, and
`context_source` labels the account whose number it is. Through 2.48.x the first account's answer
won, and a prompt sized from a 204,800-token listing failed on the 128,000-token sibling. Each
provider's own answer rides in **`offers[]`** — `{ provider, accounts, context_length,
max_output_tokens, context_source, pricing }`, in provider order — an additive field, so a client
that wants the largest window can see which provider holds it.

Both take the same router key and the same scope intersection as everything else on `/v1`. The model
set comes from the same implementation `GET /v1/models` uses, because a second opinion about what a
key can reach would be wrong in the direction of publishing a catalog the key cannot use.

**A passthrough account contributes to `/v1/catalog` and not to `/v1/models`**, which is the point of
having both. An account declaring no `supportedModels` serves any name and therefore advertises
nothing enumerable — while its upstream has told the hourly sweep exactly which models it serves. The
catalog publishes those; the wire listing cannot, because it has no way to say "and also anything
else you ask for". The operator has the discover button to promote them into `supportedModels` if
that is what they mean.

**The one exception is a Claude subscription (`anthropic-oauth`).** It has no HTTP listing and no
discover button; the Agent SDK's handshake is its only voice
([03-providers.md](03-providers.md#model-catalog--the-handshake-not-a-listing)), and a wire listing
that ignored it answered `data: []` for a pool of working subscriptions. So a subscription also lists
its `ModelCatalog` rows on `/v1/models` — the live list where the sweep has one, the shipped Claude
table until it does — deduplicated across every in-scope account, and still admitted through the same
`supportedModels` check selection runs, so an operator who narrows a subscription narrows its listing.

**Alias rows say what they resolve to.** A row whose id is an alias — the CLI's `sonnet`, or an
operator's `sonnet → glm-4.7` — carries one field neither ecosystem defines, `resolved_model`, with
the canonical id it names today: the SDK's own word for a subscription, the account's alias map
otherwise, the first in-scope account's answer where several agree. A concrete id carries no such
field (absent, not null), so a strict client sees exactly the documented shape. OpenAI shape:
`{ "id": "sonnet", "object": "model", "created": …, "owned_by": "anthropic-oauth", "context_length": 1000000, "max_completion_tokens": 128000, "resolved_model": "claude-sonnet-5-5" }`;
Anthropic shape: `{ "type": "model", "id": "sonnet", "display_name": "sonnet", "max_input_tokens": 1000000, "max_tokens": 128000, "resolved_model": "claude-sonnet-5-5" }`.
Both shapes are served on the one path, chosen by the credential style the client presented
(`x-api-key` → Anthropic, bearer → OpenAI); `GET /v1/models/:id` resolves the same way. **Resolution
is information, never a rename**: the request path sends the client's own string upstream unchanged
([Model names](#model-names)).

**Both OpenAI paths are first-class, and that is not redundancy.** `POST /v1/responses` is OpenAI's
current recommended primitive and where new clients are going; `POST /v1/chat/completions` is what the
installed base sends today. The router accepts both; neither is deprecated here.

## Counting tokens

`POST /v1/messages/count_tokens` is on the surface because **Claude Code calls it unprompted**,
before a turn, to decide when to compact its context. A router that 404s it is a router that client
half-works against.

It is an ordinary data-plane request: same router key, same scope intersection, same health
snapshot, same failover chain, one `UsageRecord` per attempt. Three things about it are not ordinary.

**It is passthrough wherever a provider can count.** A count is a statement about *one provider's
tokenizer* for *one prompt*, so the honest answer is the number that provider returns, and it is
relayed byte for byte. Neither alternative survives contact with what a client does with it:

| Candidate | Answer | Why |
|---|---|---|
| Anthropic-dialect account (API key, or a compatible vendor's Anthropic surface) | **passthrough** to `{baseUrl}/v1/messages/count_tokens` | the provider's own number |
| `openai-chat` / `openai-responses` account | **not planned** | neither dialect exposes a counting endpoint, and a different tokenizer's count is not an answer to the question asked |
| Claude subscription (Agent SDK) | **not planned** — but see the estimate below | the SDK exposes no token-count call, and the router will never forge an `api.anthropic.com` request out of a subscription's credentials — [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) |

The refusal is **per candidate**, so a pool holding one Anthropic API key and four Claude
subscriptions still answers, off the one account that can — and it counts off that account, never
by estimate. An Anthropic-compatible vendor that never implemented the endpoint answers its own
`404`, and that `404` is relayed unchanged.

**One scope the router answers for itself.** A subscription cannot be asked: the Agent SDK states
no token-count call, and forging an `api.anthropic.com` request out of a subscription's own
credentials is the thing this router exists to refuse. But a subscription is not *declining* — there
is simply **no provider in a subscription-only scope to ask**. So when the scope holds nothing but
Claude subscriptions, the router answers with its own estimate, and **says so in the body**:

    { "input_tokens": 1234, "estimated": true, "estimate_basis": "chars-per-token-v1" }

`input_tokens` keeps Anthropic's own field name, so an unmodified client (Claude Code) reads it as
the compaction threshold it expects. `estimated: true` is what makes the answer distinguishable
from a measurement, and the three fields always travel together: an `input_tokens` alone would be
a fabricated number wearing a provider's field name, which is the objection that already forbids
substituting a model. **The estimate is the router's own and is labelled as such — never a number
passed off as the provider's.**

**The estimate's basis is an approximation, and it says which one.** This router ships no Claude
tokenizer, so the number is derived from the serialized prompt content rather than from the
provider's own vocabulary: every string value of the parsed body — message text, system blocks,
tool names and descriptions, **punctuation included**, because inside a prompt a colon is text —
plus, within the content, the object keys and the primitive leaves (numbers, booleans, null):
history that grows by a hundred thousand numbers is a conversation that grew, and the estimate has
to move when it does.

**A tool call's input and a tool's schema count whole, delimiters included.** They are not
prose: they reach the model as serialized JSON — the subscription path renders a tool call as
`[the assistant called plot with {"…"}]` (`providers/claude-sdk/prompt-text.ts`) — so every brace,
comma, colon and quote of them is text the model reads. Counting their keys and leaves alone
dropped the structure, and the structure is where a growth hides: a tool input holding a hundred
thousand empty objects is three hundred kilobytes of prompt, and it measured the same as an empty
one, so a client compacting on that number never compacted.

All of it is counted as code points and divided by a **named constant**,
`ESTIMATE_CHARS_PER_TOKEN` (4), and rounded **up**. Only the request envelope contributes
nothing — the top-level fields that configure the call rather than carry context (`model`,
`max_tokens`, `stream`, …), key and value alike — and a top-level field that set does not name
counts as content, because an uncounted unknown is an under-estimate, and under is the one
direction a compaction threshold cannot afford. Outside those two JSON regions, the punctuation
around the counted pieces is the one structure a tokenizer never sees, and contributes nothing.
Up is the safe direction for a compaction threshold: a client that compacts slightly early loses a
little context, and a client that compacts late blows its window. `estimate_basis` names the
method (`chars-per-token-v1`) so a reader knows which approximation it is looking at. The
estimate is **pure** — no clock, no network, no store, no second body read (the body is already
buffered) — so the same bytes always produce the same number.

**The estimate never touches an account.** No upstream is addressed and no SDK subprocess is
spawned, so no account is cooled down, marked unhealthy, or otherwise disturbed by serving it. The
`UsageRecord` it writes carries **no account and no provider** (both null, as a preflight refusal
does) and **no egress mode** — there was no egress path.

**The precedence is three-way, and the order is the point.**

1. **A health verdict on an account that could have counted wins.** `429` with a `Retry-After`
   (cooling down, spent window, probe in flight) or `402` (exhausted). Never an estimate over a
   clock-recoverable condition: the operator is one coffee away from a working account, and "no
   account can do this" is a lie that outlives the coffee. A pool holding one Anthropic account
   that is cooling down and one OpenAI account that is fine has not run out of counters; it has
   one, and it is back at 14:32. Answering `503` there would tell the operator to add an account
   they already have, and hand the client a permanent-looking refusal for a condition a clock fixes
   — the `cooling_down` versus `exhausted` conflation non-negotiable 7 forbids, one layer above
   where it is usually made. See
   [05-routing-and-failover.md](05-routing-and-failover.md#when-the-chain-is-empty).
2. **Then the labelled estimate**, for a scope holding nothing but Claude subscriptions with
   nothing held back.
3. **Then the named refusal** — a **`503`** — for every other scope that cannot count, such as an
   OpenAI-only pool. The body was a valid Anthropic request and there is no other ingress path to
   send it down, so what is missing is an Anthropic-dialect account, which only the operator can
   add. That is the same reasoning that makes an unimplemented provider a `503` rather than the
   `400` a missing *translator* gets.

**Its `input_tokens` is never accounted, and it is never priced.** The response measures a prompt
that was never run, so the relay observes bytes and no tokens on this path: the `UsageRecord`
carries the request, the account, and the latency, with all four token columns at zero and **no
cost** — `cost_estimate` NULL, `cost_basis` `unknown`. Both halves are deliberate. Reading the
number would price a question as though it were a completion; recording a *zero* cost would be no
better, because zeroed counts against a model the price table knows come back as
`metered $0.000000`, which sums into a spend report as a completion that was free rather than as no
completion at all. Whether the model happens to be in the table may not change the shape of the
answer. The estimate is held to the same rule — zero token columns, no cost — so a count reads the
same in the spend report whichever path produced it.

**The estimate's own row is a success, not a routing failure.** It is `outcome: "success"` — never
`no_healthy_account`, never an error class. A count the router answered for itself is an answered
request; recording it as a failure would put a `NoHealthyAccountError` row in the usage feed for a
request that in fact succeeded, and would report the operator's pool as broken when nothing was
tried. The failure the estimate replaces is gone from the usage rows entirely.

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
something else. **Embedding models are absent from every shipped vendor table** — the tables price
completion models, and the ones an embedding request names are not in them — so the cost estimate is
`NULL` and the basis `unknown` (see [08-observability.md](08-observability.md#cost-estimation)),
which is honest rather than a zero that reads as free. An operator who wants their embedding traffic
costed prices it with an override, the same way they would correct any other row.

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
(`previous_response_id`, `store: true`, `include` beyond `reasoning.encrypted_content`,
`conversation`, `prompt`, `background: true`, and `item_reference` input items) against
non-Responses egress — `400`, the router holds no
conversation state; a structured-output constraint (`response_format`, `text.format`) on any
cross-dialect hop **except openai-chat → openai-responses and openai-chat → anthropic**, where `response_format` is carried (as
`text.format`, and as a forced tool call) — `400`, the shape is a contract the caller will parse; **Anthropic's own
structured-output constraint** — the third spelling of one feature, `output_config.format` and the deprecated
`output_format` it answers to — on every cross-dialect **translation** hop out of the `anthropic` dialect, since both
carriers above run the other way — `400`; and any request whose
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
| Upstream errors | Re-rendered into the **ingress** dialect on this path only. A passthrough error retains its JSON shape and nonsecret fields, but credentials are scrubbed; bodies exceeding `UPSTREAM_ERROR_MAX_BYTES` are cancelled and replaced with a safe diagnostic |

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
| Structured-output constraint (`output_config.format`, `output_format`) | The SDK is handed a prompt and a set of options, not a body, and it states no structured-output option. **Silently dropped**: the SDK path reads `output_config.effort` and nothing else of `output_config`, so the constraint is not even reported as ignored, and the subscription Account answers in prose where the caller expects JSON. The HTTP translation hops out of the `anthropic` dialect **refuse** it instead ([Known lossy edges](#known-lossy-edges)); this column does not — **not built yet** |
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

Responses refusal parts are carried toward Anthropic as text, and toward Chat in Chat's own
refusal field — `message.refusal` collected, `delta.refusal` streamed, never inside `content`, so a
structured-output caller never finds the refusal sentence in the JSON it parses. A refusal-only
answer is `content: null` plus `refusal`, `finish_reason: "stop"`, as OpenAI states it. Fragments of one part concatenate; distinct identified text/refusal parts keep
their boundaries. Completion events do not replay already emitted text.

### System prompts

| | |
|---|---|
| Clean | Anthropic `system` (string or text-block array) ⇄ OpenAI leading `role: "system"` / `"developer"` message. |
| Lossy | `cache_control` on a system block is dropped when the target has no equivalent. Multiple system blocks are concatenated with newlines in one direction and cannot be split back — except toward a surface that carries `cache_control` (`ProviderSurface.cacheControl`, `openrouter`): a system array with a marker on any block stays one text part per block, each marker on its own part, so the cached prefix ends where the client put it. |
| Dropped | Claude Code opens `system` with a billing-attribution block (`x-anthropic-billing-header: cc_version=…; cch=<checksum>;`) whose `cch` changes every request. Toward an OpenAI dialect (`instructions`, the leading system message, and the per-block parts toward a `cache_control` surface) a `system` block that starts with that prefix is **dropped**, so it cannot sit at the head of the prefix and defeat every prefix-keyed upstream cache. Only a block beginning with the prefix is removed; the same text elsewhere is untouched. **Same-dialect passthrough is deliberately untouched** (byte-passthrough, never parsed): Anthropic's own cache tolerates the header, and `claude-fast` already pins `cch=00000`. |
| Rejected | Nothing. A system prompt always has a target representation. |

### Message roles and content blocks

| | |
|---|---|
| Clean | `user` / `assistant` roles; text blocks; `image` blocks with a base64 `source` ⇄ OpenAI `image_url` with a `data:` URI; a remote-URL `image_url` ⇄ Anthropic's `source: {type:"url"}`; `tool_result` ⇄ `role: "tool"` message keyed by `tool_call_id`. |
| Mid-conversation `system` | Anthropic `role: "system"` turns (per-turn instructions; beta `tool_addition` / `tool_removal` blocks) are kept **in place**: a mid-list `system` message toward openai-chat (adjacent ones fold like any same-role run; not `developer`, which Qwen, Kimi, MiniMax and GLM endpoints refuse while all accept `system`), and a `developer` input item toward openai-responses. Only the top-level `system` field is the system prompt / `instructions`. Text is carried; a tool change is rendered as `[the client added the tool <name>]` / `[the client withdrew the tool <name>]`, the same words the Agent-SDK path uses; any other block is dropped and reported. A turn with `clear_at: "next_user_message"` that a later `user` turn followed is omitted, as the API no longer shows it. A `tool_addition`/`tool_removal` block on a user or assistant turn is dropped and reported. |
| Lossy | `detail: "low"/"high"` is dropped. Anthropic `thinking` / `redacted_thinking` blocks have no OpenAI Chat counterpart and are dropped (silently — a documented hint). Toward OpenAI, a representable URL/base64 **image inside a `tool_result`** is *hoisted*: the tool message carries the text, and images are collected into user content after the complete tool-reply run. A screenshot never splits the replies to a parallel call batch. A `document` with a `text` source travels as text. |
| Dropped and **reported** | Toward OpenAI: a `document` with any other source (a base64 PDF, a URL, a Files-API id — reported with its media type); `server_tool_use`, `web_search_tool_result`, and every block type this build does not know; a nested `tool_result` block that is neither text nor image (`tool_reference`, `search_result`). Each is left out and named — field path and block type — on one `translation dropped fields` warn line per conversion ([08](08-observability.md)). Never a `400`: Claude Code puts all of these in an ordinary transcript, and refusing the turn served nothing. |
| Rejected | Toward Anthropic: audio and file parts; an image source that is neither a base64 `data:` URI nor http(s). Toward OpenAI: a *malformed* known block (a `tool_use` with no `id`) — that body is not a valid Anthropic request. |

A remote URL is **never fetched and inlined**. A translator is a pure function, and reaching an
arbitrary URL from inside one puts a network call — and an SSRF surface — on the request path;
Anthropic's own `url` image source carries the reference instead, so the fetch never has to happen.
A dropped block is never dropped *quietly*: the `translation dropped fields` line names it, so an
operator can tell "the PDF never reached the model" from "the model ignored the PDF". The earlier
rule — refuse a `document` with `400` — was retired when production showed what it cost: a coding
agent cannot rewrite the turn it is replaying, so the refusal ended the session rather than the
attachment.

Anthropic requires strict `user`/`assistant` alternation; OpenAI does not. Translating toward
Anthropic merges consecutive same-role messages rather than reordering them. Merging concatenates
content the model was going to read in that order anyway; reordering would change what it was told.
Every `role:"tool"` message becomes a `tool_result` block on a **user** turn, so a run of them
merges into one turn — which is exactly the shape Anthropic expects. Toward OpenAI the same merge
runs for plain-content turns only: alternation is not required there, but several
OpenAI-compatible upstreams reject two adjacent `user` messages that OpenAI itself accepts. A turn
carrying a `tool_call_id` remains separate. Responses assistant text and adjacent `function_call`
items are assembled into one assistant message with the ordered call list before their replies;
ordinary user/tool boundaries still end that group.

### Tool and function calling

| Direction | Shape |
|---|---|
| Anthropic → OpenAI | `tools[].{name, description, input_schema}` → `tools[].function.{name, description, parameters}`; `tool_choice: {type:"auto"\|"any"\|"tool", name}` → `"auto"\|"required"\|{type:"function",function:{name}}` |
| OpenAI → Anthropic | inverse; `strict: true` has no Anthropic equivalent and is dropped |
| Calls | Anthropic `tool_use` block `{id, name, input}` ⇄ OpenAI `tool_calls[].{id, function.{name, arguments}}` — `input` is an object, `arguments` is a **JSON string**; both directions parse/serialize |
| Results | Anthropic `tool_result` `{tool_use_id, content, is_error}` ⇄ one `role:"tool"` message per call; `is_error` has no OpenAI field and is folded into the result text |
| Clean | Name, description, JSON Schema parameters (on a surface with `stripLookaroundPatterns`, lookaround `pattern`s excepted — see below), call ids, parallel calls (Anthropic emits several `tool_use` blocks; OpenAI emits several `tool_calls` entries). Ids and parallel call order are preserved; result messages retain their own call IDs. |
| Lossy | `is_error`, `strict`, `defer_loading`, `eager_input_streaming`, `cache_control` on a tool. `parallel_tool_calls` is carried between the OpenAI dialects and mapped to the inverse Anthropic `tool_choice.disable_parallel_tool_use`. An explicit policy without a tool choice creates `type: "auto"`; an absent policy stays absent |
| Dropped and **reported** | Anthropic **server-side and built-in** tool types toward OpenAI — a declaration with a `type` and no `input_schema`: `web_search_*`, `tool_search_tool_*`, `code_execution_*`, `bash_*`, `text_editor_*`, `computer_*`, `memory_*`. A capability of Anthropic's own inference, or a tool whose schema Anthropic supplies, that no other upstream can act on. Left out by name; the client's own tools go through. A `tool_choice` naming a dropped tool goes with it, and a toolkit that translated to nothing is omitted rather than sent as `tools: []` (several compatible upstreams refuse the empty list). A `defer_loading: true` tool is sent up front — a target with no tool search gets every tool, which is the faithful reading of "deferred". On a surface with `stripLookaroundPatterns` (the Codex subscription), a JSON-Schema `pattern` containing a regex lookaround is removed from the translated schema and reported by tool name and schema path |
| Rejected | A tool with no name, or whose schema is not a valid JSON Schema object type — not a valid Anthropic declaration |

Responses `function_call_output` images remain native text/image blocks toward Anthropic.
Toward Chat, the result text stays in its keyed tool message and images are hoisted after the
contiguous result run; remote image URLs are carried through existing validation and never fetched
by the translator. Anthropic image Files-API handles are dropped and reported at their original field path, including
inside tool results. The translator never fetches a provider file.

Reasoning items replayed into non-Responses egress are dropped. A summary is omitted rather than
presented as assistant text; an `encrypted_content` handle — account-bound, readable by nothing but
the provider that minted it — is dropped and **reported** by field path (never refused: it hides no
turn, and Codex replays one on every request), together with `include:
["reasoning.encrypted_content"]`. Provider item references still cannot be replayed and stay `400`.

Tool streams with no argument fragments emit `{}` once for a no-argument call. Repeated
indexless fragments with the same call ID extend one call. Toward Anthropic, argument blocks remain
open until the Chat sentinel or stream end so late argument fragments cannot target a closed block.
A completed tool call with raw Chat `stop` or an absent finish reason maps to `tool_use`; known
content filtering, truncation, and unknown reported reasons retain their established mappings.

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
| `content_block_delta` / `thinking_delta` (router-signed block, see below) | `delta.reasoning_content` / `delta.reasoning` — **read, never written**; see below | `response.reasoning_summary_text.delta` |
| `content_block_stop` | — (implied) | `response.content_part.done` / `response.output_item.done` |
| `message_delta` (stop reason, usage) | final chunk `finish_reason` + optional usage chunk | `response.completed` (carries usage) |
| `message_stop` | `data: [DONE]` | `response.completed` |
| `ping` | — (dropped) | — (dropped) |
| `error` | error chunk, then stream close | `response.failed` / `error` |

| | |
|---|---|
| Clean | Text deltas, tool-call argument deltas, terminal usage, stream termination. |
| Lossy | Block indices and boundaries are reconstructed, not preserved; a dialect with no "block" concept loses which block a delta belonged to. Reasoning text is dropped toward `openai-chat`; toward `anthropic`, openai-chat reasoning text and a Responses reasoning *summary* both become a `thinking` block signed with the router's tag (below). Toward `anthropic`, `message_start` states a zeroed `usage`. Toward `openai-responses`, item ids (`msg_…`, `fc_…`, `rs_…`) are minted from the response id and the item's position, and a thinking or reasoning delta becomes a reasoning *summary* delta — the encrypted reasoning handle a native Responses upstream also emits cannot be synthesized and is not. |
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

Toward `anthropic` the same text becomes a `thinking` block, exactly as a Responses reasoning
summary does (next paragraph). It used to be dropped, on the reasoning that a client replays an
assistant turn verbatim and Anthropic refuses a signature this router cannot mint. The drop had a
cost that reasoning missed: a thinking model's translated stream carried `message_start` and then
nothing but keepalive comments for as long as it thought, and a comment is no event to any SDK
reader. Measured 2026-10-18, in-pod, one `/v1/messages` request to `qwen3.8-max`: 341 s of comments
before the first `text_delta`; the developerz-ai router recorded 20 streams on that account in
three days cancelled by the client's silence policy at 200–308 s with zero output tokens. The
replay hazard is the one the signed summary already carries, and is bounded the same way.

A **Responses reasoning summary**, and **openai-chat reasoning text**, become a `thinking` block
(stream: `thinking_delta`s, then a `signature_delta`; non-stream: one block ahead of the text) whose
`signature` is the router's tag `mar1:` —
versioned, naming its origin, carrying no key, account id or upstream handle. Replayed on the next
turn, every `anthropic → X` translator drops it with all other thinking blocks, and the Agent SDK
path never replays thinking. The residual edge: a client that moves that transcript to a **real
Anthropic** upstream mid-conversation goes through same-dialect passthrough, which never parses the
body, and Anthropic refuses the foreign signature with a `400`.

**Encrypted reasoning on anthropic ⇄ openai-responses is carried, sealed to one account.** A
reasoning model's encrypted reasoning item is part of the prompt prefix the upstream caches; dropping
it on step N+1 of a tool loop broke the cache at step N's output every step (prod: router
`gpt-6.1-sol` cache hit 0.07 / 0.64 / 0.89 by step). So when the dataplane hands the translator the
selected account's reasoning seal (`crypto/reasoning-seal.ts`, HKDF-derived from `ENCRYPTION_KEY`,
per account, deterministic `mrs1.<blob>.<mac>`), the request asks for
`include: ["reasoning.encrypted_content"]`, and each finished reasoning item goes back to the client as
a `thinking` block whose `signature` is the sealed handle — or a `redacted_thinking` block whose
`data` is, when the upstream wrote no summary. Streaming, the signature is emitted on the item's own
`response.output_item.done`, the event that closes the block anyway, so nothing is held back. On the
next turn a `thinking` / `redacted_thinking` block on an assistant turn is replayed, in place, as a
`reasoning` input item (`summary` + `encrypted_content`) **only when the seal of the account the turn
lands on opens it**; another account's handle (a failover or pool move), a tampered one, Anthropic's
own signature and the stateless `mar1:` tag are all dropped exactly as before, so a handle never
reaches an upstream that did not issue it. The seal is deterministic, so the replayed item is
byte-identical every turn and the prefix stays cacheable. `mrs1` replaces `mar1:` only on blocks that
carry a sealed handle; every other synthesized block (no seal, no handle, openai-chat reasoning) keeps
`mar1:`. The passthrough residual above applies to an `mrs1` signature too.

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

**Interleaved tool arguments are never silently discarded when text arrives.** The router keeps
sequential target blocks/items in first-sighting order. The live call's arguments continue to leave
incrementally; text and later calls which cannot enter that block wait in a bounded queue. A
confirmed Responses `output_item.done` releases that call's queued text without closing another
still-streaming call. Chat has no per-call completion event, so its held fragments leave when the
turn finishes. This is a router ordering policy, not a claim that every indexed event format bans
concurrent items. Anthropic's high-level TypeScript client callbacks read the latest block even
when accumulation uses the event index, which makes simultaneous open blocks unsafe for those
callbacks. See the [official client implementation](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/MessageStream.ts).

`MAX_TRANSLATION_PENDING_BYTES` defaults to 1048576 and accepts whole values from 1024 through
33554432. It bounds each deferred-fragment backlog, item-alias map and snapshot recovery tracker,
including a per-entry accounting allowance. Empty item announcements also reserve identity space;
ID-only and index-only fragments for one item use the same tool ordinal and text boundary.
It is not a response-body or observation ceiling. Ordinary live
deltas are not held for their final snapshots. Split surrogate fragments release their original
charged bytes when an entry drains, so repeated drain cycles cannot manufacture an overflow.

**Responses final snapshots can recover only a missing suffix.** Text/refusal `.done` events and
final message/function-call items are matched by item/content identities, with item-ID/output-index
aliases reconciled. A full function call stated on `added` or `done` retains its ID, name and complete
arguments. The tracker keeps a length and incremental SHA-256 digest of UTF-16 code units instead
of retaining emitted text; this preserves split or lone surrogate units without normalization.
Repeated equal mirrors emit nothing. A different final prefix, changed final value, conflicting
identity, or later delta after finalization fails honestly. An unscoped final mirror is ignored
rather than attached to an arbitrary item. The [Responses event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)
defines the final snapshot fields; it does not promise that ordinary providers omit their deltas.

A local consistency or pending-limit fault emits the established target error envelope and settles
usage once as `router_error`, with `translation_protocol_error` or `translation_pending_overflow`.
Original upstream HTTP facts and the already-sent client status are preserved. It creates no
account health strike or retry, and a later upstream completion cannot replace that verdict. The
Chat error envelope is followed by its protocol close markers, not a successful accounting verdict.

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

The recognized Anthropic `stop_reason` set is `end_turn`, `max_tokens`, `stop_sequence`,
`tool_use`, `pause_turn`, `refusal`, and `model_context_window_exceeded`. Every one has a row below; an unrecognized value is a provider
change, logged and mapped conservatively to `end_turn` / `stop`, never dropped silently.

| Anthropic `stop_reason` | OpenAI `finish_reason` | Responses | Note |
|---|---|---|---|
| `end_turn` | `stop` | `status: "completed"` | clean, both ways |
| `max_tokens` | `length` | `incomplete_details.reason: "max_output_tokens"` | clean, both ways |
| `model_context_window_exceeded` | `length` | `incomplete_details.reason: "max_output_tokens"` | context truncation; the narrower cause is lost toward OpenAI |
| `tool_use` | `tool_calls` | `status: "completed"` with a function-call output item | clean, both ways |
| `stop_sequence` | `stop` | `status: "completed"` | lossy → OpenAI: *which* sequence matched (`stop_sequence` field) is lost |
| — | `content_filter` | `incomplete_details.reason: "content_filter"` | lossy → Anthropic: mapped to `end_turn`, the refusal reason is lost |
| `pause_turn`, `refusal` | `stop` | `status: "completed"` | lossy → OpenAI |
| — | `function_call` | — | OpenAI's superseded single-function form; still emitted by some compatible upstreams, so it is read as `tool_use` rather than falling to `end_turn` and reporting a tool call as text |

Because a translator is a pure function with no logger behind it, the mapping **returns** the
unrecognized value alongside the conservative one; the caller — which holds the request id — is what
logs it. One line per provider change, none in steady state.

**Absence is a fourth case, and it is not symmetric.** Anthropic's `stop_reason` is legitimately
null — the Agent-SDK renderer emits exactly that for a turn whose stream ended mid-block, because
nothing stated one and a router must never fabricate model output. openai-chat has no null finish:
a chunk carrying `finish_reason: null` says *more is coming*, so forwarding the absence on the
**terminal** chunk ends a stream in which nothing ever finished, and a reader waiting for a finish
reason is right to complain. So the mapping itself stays honest — absence maps to absence, which is
what a mid-stream delta needs — and the streaming translator applies the conservative value when it
is emitting the terminal chunk and the upstream named none. It is not reported as an unrecognized
value: nothing unknown arrived, and a log line per truncated turn would be noise.

**A declared upstream error terminates a translated Chat stream.** Once bytes are out the status
cannot change, so the failure is spelled in the body — but the client's reader is still reading. The
error goes out first, so nothing masks it, and toward Chat is followed by a terminal chunk (if the completion
had not already stated its own ending) and `[DONE]`. Emitting the error and stopping dead left the
reader waiting at EOF and surfaced as a parse failure with the real cause nowhere in it — opencode's
`Failed to read … stream` on a long agent turn, 2026-09-06.

**A translated stream must not go silent while the upstream is loud.** Dropping a frame is a
decision about *content*, and it is the right one — `thinking` and `redacted_thinking` deltas have
no openai-chat counterpart. But an extended-thinking model spends its opening stretch emitting
nothing else, so the upstream stream is busy while the translated one writes zero bytes, and the
client's connection sits idle through the whole thinking phase until something under it gives up.
Measured in-cluster on 2026-09-06, one prompt against one account back to back:
`/v1/chat/completions` received 210 bytes and the socket closed at 11.9 s, while `/v1/messages` —
the byte relay, no translation — carried 20,469 bytes of the same answer and was still streaming at
22 s. So a chunk that produces no client event still keeps the connection alive when it has been
quiet long enough (`DEFAULT_TRANSLATED_KEEPALIVE_MS`, 5 s). It goes out as an SSE **comment**, which
carries no event and no data in any dialect, so a dropped frame never acquires a counterpart just
because the connection needed a byte; it does not count as the first byte, for the same reason a
forwarded upstream keepalive does not; and it is bounded by a cadence rather than sent per chunk, so
a stream that merely drops a few frames pays nothing.

**A stream truncated at the transport still gets nothing.** That case is different in kind: the
upstream never said the message was over, so a synthesized terminator would report a completion that
did not happen. The two cases above are stories with an ending — one that failed to name why, one
that named a failure — and only those two earn a terminator.

### Usage and token fields

Anthropic reports exactly four fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`.

| Anthropic | OpenAI Chat | Responses |
|---|---|---|
| `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` | `prompt_tokens` | `input_tokens` |
| `output_tokens` | `completion_tokens` | `output_tokens` |
| (sum) | `total_tokens` | `total_tokens` |
| `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` (DeepSeek: top-level `prompt_cache_hit_tokens`) | `input_tokens_details.cached_tokens` |
| `cache_creation_input_tokens` | folded into `prompt_tokens`; read back from OpenRouter's `prompt_tokens_details.cache_write_tokens` | folded into `input_tokens` |
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
estimate built on it. `cache_creation_input_tokens` is never invented in the other direction: plain
`openai-chat` reports cache reads only, and guessing the write is the one number an operator reads to
decide whether caching is paying for itself. An upstream that **does** report a write — OpenRouter's
`prompt_tokens_details.cache_write_tokens`, inside `prompt_tokens` — has it mapped through to
`cache_creation_input_tokens` and subtracted out of `input_tokens` beside the read; unreported, the
field stays absent.

The **`UsageRecord` stores the upstream's own numbers**, not the translated ones. OpenAI streams omit
usage unless `stream_options.include_usage` is set; translating an Anthropic stream toward
`openai-chat` emits the client usage frame only when the original client request explicitly sets
`stream_options.include_usage: true`. Accounting still observes upstream usage when the client frame
is omitted. A missing field is recorded as null, never as zero — zero is a
measurement, and reporting it for a field the upstream never sent invents data.

Reading an Anthropic stream for the `UsageRecord`, `message_start` is a complete input bundle (a
cache field it omits is zero for that message), while a `message_delta` restates only the fields it
names: several Anthropic-compatible upstreams (MiniMax, z.ai) repeat `input_tokens` on the final
delta without the cache fields, and that keeps the cache counts `message_start` reported rather than
zeroing them. An OpenAI-shaped upstream's cache write is recorded when it states one (OpenRouter's
`cache_write_tokens`) and is otherwise zero — those upstreams bill no separate write.

#### Per-call cost on the wire

A response **the router writes** states what the attempt cost, in its `usage`, OpenRouter-compatible:

```json
"usage": { "...": "...", "cost": 1.215, "cost_source": "estimated", "cost_basis": "metered" }
```

| Field | Meaning |
|---|---|
| `cost` | USD, a JSON number. The `UsageRecord`'s own `cost_estimate`: one pricing path (`attemptCost`, `dataplane/records.ts`), so the long-context tier and the operator's price book apply, priced on the upstream's counts and the post-alias model |
| `cost_source` | Always `estimated`: the router prices from a table, nothing here is a provider's measurement |
| `cost_basis` | `metered`, or `notional` on a subscription account: what the call would have cost on the API, an attribution and not a spend ([08](08-observability.md#cost-estimation)) |

Where it rides: the body's `usage` on a whole response; on a stream, the one final usage frame.
That frame is `message_delta` toward `anthropic`, the usage-only chunk toward `openai-chat` — found
by parsing: a `usage` object beside `choices: []`, so a content chunk that also carries usage is not
stamped (it exists only when the client set `stream_options.include_usage`; the router adds no frame
of its own),
and `response.completed` / `response.incomplete` toward `openai-responses`, under `response.usage`.

**Which responses carry it.** Every translated inference response, including a Claude subscription
reached from an OpenAI dialect. **A same-dialect one only on request.** That body is the upstream's
bytes (non-negotiable 10), so by default it states none. A caller that sends
**`x-router-usage: cost`** trades byte identity for the figure on that request: the answer is
re-framed through the translated relay with an identity pair (`relay-cost-optin.ts`) — a JSON body
parsed and re-serialized with the cost in its `usage`, a stream re-framed per SSE event with the cost
on the final usage frame. Content and order are unchanged; JSON formatting and SSE fields other than
`event:` / `data:` are not kept. The header is read off the client request and never forwarded; any
value but `cost` is refused `400 invalid_request` before an upstream is asked. Without it, every path
is unchanged — same bytes, same latency. A cost an upstream states itself (OpenRouter's
`usage.cost`) is its own word and is kept as sent, opted in or not.

**Absent, never zero.** The fields are left out when no rate is known, when the upstream stated no
counts, or when the observation could not trust them (`usageInvalid`, `evidenceUnavailable`). A
stated `0` claims the call was free. `count_tokens` and embeddings price nothing and state nothing.

**It adds no time to first token.** The stamp touches only the final usage frame, the one frame that
has to wait on the usage observer (`relay-cost.ts`). Everything ahead of it in the same chunk is
written first, and the chunks before it are unaffected.

### Error shapes

| Dialect | Shape |
|---|---|
| Anthropic | `{"type":"error","error":{"type":"invalid_request_error","message":"…"}}` |
| OpenAI | `{"error":{"message":"…","type":"invalid_request_error","param":null,"code":null}}` |

Rules: an upstream error is translated into the **ingress** dialect, so a Claude Code client always
receives an Anthropic-shaped error even when the account that failed was an OpenAI one — or an
Agent-SDK one. Router-origin errors (`NoHealthyAccountError`, `QuotaExhaustedError`, …) use the same
shape with a stable HTTP status. `param` and `code` are best-effort and may be null. No error body
ever carries credential material; an account appears only as its operator label inside a router
sentence and as an opaque reference in `error.router` — never a row id or a provider-side identity.

#### The router error object

Every error the router authors carries **`error.router`** beside the sentence, in every dialect:
inside the `error` member, so an SDK that hands the caller only that member (the OpenAI SDKs do)
still shows it. That is everything `errorHandler` / `notFoundHandler` render (`toErrorResponse` /
`notFoundResponse`: every thrown `RouterError` on the data and admin planes, a cancelled, shut-down
or unadmitted request, an unknown `500`, a `404`), every admin-plane refusal (`failureBody`, the
sign-in routes; `refusalBody` in `errors/render.ts` — `wall: request`, or `clock` with
`retry_after_s` for the sign-in lockout), the `/metrics` `401`, and the event that ends a stream the
upstream broke after its first byte (below). Additive: the sentence is unchanged and frozen by
`test/unit/errors/frozen-sentences.test.ts` until developerz.ai reads this object alone. Not on an
upstream's own error the router relays — those are the provider's words, in-stream or not — nor on
a translator's rendering of one, nor on the HTML sign-in callback pages; the `x-router-*` headers
below name the account. One relayed refusal does carry it: a Claude subscription's fast-transport
`invalid-request` (an upstream `400`/`413`/`422`, 2.55.0). That body never holds the provider's own
words, because `claude-fast/response.ts` replaces them with a router sentence. So it is rendered as the
router's own `InvalidRequestError`, in every dialect: `wall: request`, `scope: account`, and `signal`
set to the classifier's token (e.g. `claude-sdk:api-status-400`). Anthropic's scrubbed text goes to the
attempt log as `upstreamMessage` and nowhere else.

**A stream that broke after its first byte** (an upstream reset, its idle deadline, the router
shutting down) cannot fail over, so it ends with one router event and a clean close
(`services/dataplane/relay-stream-end.ts`), opened by a blank line so a fragment the upstream left
half-written cannot swallow it:

| Ingress | Event |
|---|---|
| `anthropic` | `event: error` · `{"type":"error","error":{"type":"api_error","message":…,"router":{…}}}` (`overloaded_error` on shutdown) |
| `openai-chat` | `data: {"error":{"message":…,"type":"server_error","param":null,"code":<signal>,"router":{…}}}` then `data: [DONE]` |
| `openai-responses` | `event: error` · `{"type":"error","code":<signal>,"message":…,"param":null,"router":{…}}` — the Responses error event is flat, so `router` sits at its top level |

`router` there is `wall: capacity`, `retryable: true`, `scope: account` (`router` on shutdown),
`signal` one of `upstream_error` / `upstream_timeout` / `router_shutdown`, `accounts` the one
account that served (`state` = the signal), `attempts` the attempt that served, `request_id` the
request id. The message: `the upstream stream failed after the response began (<signal>); not
retried, bytes were already sent`, or `the router shut down after the response began; not retried,
bytes were already sent`.

```json
{"type":"error","error":{"type":"rate_limit_error","message":"…","router":{
  "wall":"clock","scope":"pool","retryable":true,
  "reset_at":"2026-11-06T18:00:30.000Z","reset_source":"estimated","retry_after_s":30,
  "accounts":[{"account":"acct_3f2a…","state":"cooling-down","reset_at":"2026-11-06T18:00:30.000Z"}],
  "pools":["coding"],"signal":"cooling-down","attempts":0,"request_id":"9c1e…"}}}
```

| Field | Meaning |
|---|---|
| `wall` | What clears it, fixed per error code (`packages/core/src/wall.ts`): `clock` (`429`: wait `retry_after_s`), `capacity` (`503`/`504`: retry later, no instant), `human` (`402` top-up, `502` re-auth, `500` stored credential, `401` revoked key), `scope` (`403`, `404` model: another key or model), `request` (`400`/`413`/`415`, `499`: change the request), `internal` (an unknown `500`). One code is typed to three: a `503` `no_healthy_account` is `capacity` unless its throw site names `human` (only disabled / needs-re-auth / credential-rejected members; a missing base URL or config directory; a provider with no driver) or `scope` (no account serves the model; none performs the operation) |
| `scope` | Who the verdict is about: `pool` (selection judged every account the key reaches), `account` (one upstream account's own answer, the most actionable the chain held), `session` (a bound session's account), `key`, `request`, `router` |
| `retryable` | `true` exactly when `wall` is `clock` or `capacity` |
| `reset_at`, `reset_source` | A `429`'s refill instant and its provenance (`provider-reported` / `estimated` / `unknown`); `null` otherwise. A `402` never carries one |
| `retry_after_s` | Equal to the `Retry-After` header, `null` when none is sent |
| `accounts` | The accounts the verdict names, as `{account, state, reset_at}`: on a `pool` verdict every member by its filter reason (`cooling-down`, `quota-window-spent`, `probe-in-flight`, `exhausted`, `needs-reauth`, `model-unsupported`, …), otherwise each attempted account by its usage outcome. `account` is opaque: `acct_` + 16 hex of SHA-256 of the router id (`errors/account-ref.ts`), the same value as `x-router-account`. Opacity holds only once a caller stops reading sentences: the frozen session-bound one prints the raw router id |
| `pools` | Names of the pools selection drew from |
| `signal` | Scrubbed like the message. The machine token that decided it: a classifier signal (`anthropic:rate_limit_error`, `openai:insufficient_quota`), a filter reason, `no-account-in-scope`, `timeout`; `null` when none |
| `attempts` | Upstream attempts made before the router answered; `0` when none |
| `request_id` | The request id, as `x-request-id` |

#### Router response headers

On every data-plane answer — success or failure, stream or body (`dataplane/router-headers.ts`):

| Header | Value | When |
|---|---|---|
| `x-router-request-id` | the request id (also `x-request-id`) | every answer, both planes |
| `x-router-attempts` | upstream attempts this request made, every usage row an account wrote — a stale-session replay counts twice, success or failure; `0` for none | every `/v1` inference answer and every rendered error (`0` for one refused before the dispatcher) |
| `x-router-served-model` | the model the upstream was asked for, after the account's alias map | an account answered, including its own relayed error |
| `x-router-provider` | that account's provider id | same |
| `x-router-account` | that account, opaque (as in `error.router.accounts`) | same |

A stream carries them on its headers, before its first byte; nothing waits on them.

**A context overflow is always recognisable**, because it is the one failure a client recovers from
on its own (compact the transcript, retry). An upstream code `context_length_exceeded` or a message
containing `prompt is too long`, whatever status it arrived under — an in-stream `response.failed`
has none and would otherwise render as a `500` `api_error` — renders as `invalid_request_error` in both
dialects. The OpenAI shape carries `code: "context_length_exceeded"`; the Anthropic shape has no
`code`, so the message is reworded in Anthropic's own prose with the upstream code in parentheses
(`prompt is too long: <upstream message> (context_length_exceeded)`), and an Anthropic upstream's own
`prompt is too long: …` message is left exactly as written. One choke point (`errors/render.ts`),
so the streamed and non-streamed paths cannot disagree.

A recognized nonstreaming error envelope remains an ingress-shaped error even when the upstream
returns HTTP 200. Chat requires an object `error`; Anthropic requires `type: "error"` with an object
`error`; Responses requires `type: "error"`, `type: "response.failed"`, or `status: "failed"`.
The received HTTP status remains unchanged. Unknown vendor envelopes are not inferred as errors.

That last rule is enforced, not trusted: every message leaves through one function, and it runs the
same value-level scrub the log redactor uses ([08-observability.md](08-observability.md)). Both
halves of a body need it — a relayed upstream message can quote a key back at us, and a
router-authored one interpolates upstream text (`"every attempt failed: …"`).

One router-origin status is worth naming because it is easy to get wrong: a body over
`MAX_REQUEST_BODY_BYTES` renders as `413` — `request_too_large` in the Anthropic vocabulary,
`invalid_request_error` with `code: "request_too_large"` in the OpenAI one — and never as `400`. Both
are the caller's to fix, and the remedies are opposites: `400` says the request is malformed and
sends a developer hunting a bad field in a body that was merely long.

The refusals the router makes **before a body has named a model** are separate from translation and
say which they are. None is `translation_failed` — nothing was translated — and each is decided from
what is already in hand (a header, a byte count), never by parsing or decompressing the body:

| Request | Status | `code` | Message says |
|---|---|---|---|
| `Content-Encoding` present (anything but `identity`) | `415` | `unsupported_content_encoding` | compressed request bodies are not supported; names the encoding |
| Zero-length body | `400` | `invalid_request` | the request body is empty |
| Bytes, but no top-level string `model` (not JSON, a top-level array, a non-string model) | `400` | `invalid_request` | the request body must name a model |
| A `model` longer than the name ceiling | `400` | `invalid_request` | the model name is longer than the ceiling |

The router does not decode request bodies: routing reads the model name out of the raw bytes and a
same-dialect body goes upstream untouched, so a compressed body is refused before it is read rather
than answered "must name a model" — true of the bytes, useless to a caller whose body named one. In
the Anthropic shape all four render as `invalid_request_error` (the type follows the status, below);
the OpenAI shape carries the `code`. None writes a `UsageRecord` — there is no model to put on the
row — and all count on `router_requests_total{outcome="client_error"}`.

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
| `cache_control` hints | `anthropic` → `openai-chat` on a surface stating `cacheControl` (`openrouter`) | **carried** on the content part the marked block became (text, image, text document, and a `tool_result` — its own marker, else the last nested one — on its tool message's single text part), and a top-level marker at the top level. A marked lone text part is not collapsed to a string. `ephemeral` with an optional `ttl` only; any other marker is absent, never a `400`. A marker on a `tool_use`, a thinking block or a mid-conversation `system` turn has no part to sit on and is dropped. OpenRouter maps the marker per provider (Anthropic, Gemini, Qwen, OpenAI `prompt_cache_breakpoint`; openrouter.ai/docs/features/prompt-caching, read 2026-11-03). Prod 2026-11-03: Claude through router → OpenRouter carried zero breakpoints |
| `cache_control` hints | `openai-chat` → `anthropic` | **carried**: OpenRouter's marker on a text or image part lands on the block it became; a marked system message keeps its own system block (the prompt is then a block array, otherwise the joined string as before); a marked tool message puts the marker on its `tool_result`. Block-level markers go to every anthropic surface — they are the dialect's own. The top-level marker goes only to a surface stating `cacheControl` (`anthropic-api`): the client's own, else — when the request carries no marker anywhere — Anthropic's automatic `{type: "ephemeral"}`, never beside a client marker since both count toward the cap of four. Prod 2026-11-03: an OpenAI-wire client on Anthropic got zero caching, as Anthropic caches only at a breakpoint |
| `cache_control` automatic marker | `openai-responses` → `anthropic` | Responses states no marker, so toward a surface stating `cacheControl` (`anthropic-api`) every request carries the top-level automatic marker; toward any other anthropic surface none |
| `cache_control` hints | → any other non-Anthropic | dropped; a strict vendor `400`s on the field. The upstream caches automatically or not at all. Prompt caching is per-account, which is why routing is sticky |
| OpenAI `logprobs` / `top_logprobs` | → `anthropic` | no counterpart; rejected with `400` rather than silently ignored |
| OpenAI `n > 1` | → `anthropic` | no counterpart; rejected with `400` |
| `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias` | → `anthropic` | dropped (documented, not rejected — they are hints, not contracts) |
| Anthropic `top_k` | → OpenAI | dropped |
| Remote-URL images | → `anthropic` | carried as Anthropic's `source: {type:"url"}`, never fetched — see [above](#message-roles-and-content-blocks). `detail: "low"/"high"` is dropped |
| Absent `max_tokens` | → `anthropic` | Anthropic requires one and OpenAI's is optional. The selected Account's exact upstream model uses its warm, positively sourced output ceiling when available; otherwise the configured translation default applies. Explicit client limits remain unchanged. Each failover candidate uses its own alias and ceiling, without a database lookup on dispatch |
| Anthropic server-side and built-in tools (web search, tool search, code execution, `bash_*`, `text_editor_*`) | → OpenAI | **dropped and reported by name**; the client's own tools go through. See [Tool and function calling](#tool-and-function-calling) |
| `tool_choice` naming a dropped tool | → OpenAI | dropped and reported with it; an empty surviving toolkit is omitted, never sent as `tools: []` |
| Anthropic `document` blocks | → OpenAI | a `text` source travels as text; any other source is **dropped and reported** with its media type |
| `server_tool_use`, `web_search_tool_result`, unknown block types; non-text/image blocks nested in a `tool_result` | → OpenAI | **dropped and reported** by field path and type — the provider's own artifacts, whose visible outcome is already in the text beside them |
| An image inside a `tool_result` | → OpenAI | representable URL/base64 images are **hoisted** into user content after the complete tool-reply run, preserving call IDs and image order; Responses-to-Anthropic results retain these image blocks. Anthropic Files-API images are dropped and reported as described above |
| `thinking`, `output_config`, `context_management`, `metadata`, `container`, `mcp_servers` (request-level) | → OpenAI | dropped silently — knobs of Anthropic's own inference with no target field — except the reasoning dial: `output_config.effort` and a `thinking` budget have their own rows below, and the structured-output constraint `output_config.format`, which is **refused** `400` rather than dropped (the row below) |
| Upstream SSE comment lines (`: keep-alive`, `: OPENROUTER PROCESSING`) | translate egress, any pair | **forwarded** as comment lines, ahead of the frames they arrived with. They are how a provider holds a socket open through a long time-to-first-token, and a relay that swallowed them left the client silent for exactly that window. They do not count as the first byte. Passthrough forwards them with everything else |
| OpenAI built-in tools (`web_search_preview`, `file_search`, `code_interpreter`, …) | `openai-responses` → any | unsupported; `400`. Served inside OpenAI's own inference, so nothing on the other side of the seam runs one |
| `stop` / `stop_sequences` | → `openai-responses` | no counterpart — the dialect has no stop parameter at all; **rejected** `400`, because a stop sequence decides where the answer ends and dropping it returns text past the delimiter the caller drew |
| `text.format` (structured output / JSON Schema) | `openai-responses` → any | `{"type":"text"}` passes; anything else is **rejected** `400`. A schema-constrained answer is a contract the caller will parse, and prose in its place is a different answer, not a degraded one. The reverse of the carried row below is not implemented: carrying `text.format` onto an openai-chat upstream needs each chat vendor's own `response_format` support proven first |
| Forced `tool_choice` (`any` / `tool`), anthropic → anthropic passthrough | vendors with `thinkingOnByDefault` (minimax, zai, kimi, anthropic-compatible) | **the one passthrough edit besides the model name that parses the body** (`services/dataplane/body/forced-tool-thinking.ts`), only when the bytes contain `tool_choice`: `thinking` absent, `enabled` or `adaptive` → `thinking: {type: "disabled"}` stated, because these vendors think by default and ignore the force (MiniMax: `end_turn` prose, 2026-10-15; the AI SDK's `generateObject` sends exactly this). The force is the caller's contract and thinking is a dial, so the dial yields rather than the router refusing a request the vendor can serve — the earlier `400` on `enabled` / `adaptive` cost 538 router-made failures in a day (v2.37.3, prod 2026-10-15..16) and is gone; a forced tool answered in prose is coerced downstream (`dataplane/forced-tool-coercion.ts`). A `thinking` the caller already set to `disabled` is left untouched. `anthropic-api` is never touched. The translated path states the same `thinking: disabled` (`openai-chat-to-anthropic/request.ts`) |
| `thinking: {type: "disabled"}` toward a model that requires thinking | anthropic egress (passthrough or translated) to a model a driver lists in `thinkingRequiredModels` (minimax: the `MiniMax-M3.1-Flash` family; opencode-go: `minimax-m3.1-flash` on its anthropic surface) | **becomes `thinking: {type: "adaptive"}` at the lowest effort**, whoever wrote the `disabled` — the client, the forced-tool edit above, a structured output or `reasoning_effort: none` (`keepThinkingForRequiredModel`, logged `thinking kept on`). An `output_config.effort` already in the body that the vendor names (`low`, `medium`, `high`, `xhigh`, `max`) is the client's and is kept; anything else becomes `low`, the nearest the model comes to off. Absent thinking is left absent (the vendor's default stands, as the client chose). The model refuses `disabled`: `400` `model "MiniMax-M3.1-Flash" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)`. Through 2.51.0 the field was only removed, so every forced-tool call ran at MiniMax's default `max`. Driven live 2026-11-06 through OpenCode Go: `adaptive` + `low`, bare `low`, bare `max` and no thinking each answer `200` with the forced tool. The forced `tool_choice` is kept, not degraded to `auto`; a forced tool answered in prose is coerced downstream (row below) |
| Forced tool answered in text | anthropic response from a `thinkingOnByDefault` vendor, any ingress | **coerced** (`translate/shared/forced-tool-coercion.ts`, `dataplane/forced-tool-coercion.ts`): when the upstream body forces a tool (`tool_choice` `tool` naming X, or `any` with exactly one tool) and the answer carries no `tool_use`, text that is a single JSON object (bare or in one json fence) becomes X's `tool_use` (`toolu_` id, `stop_reason: tool_use`, other text dropped, usage kept, schema not checked). Prose, arrays, `max_tokens`, `any` over several tools: unchanged. The response is buffered whole, streams included, and re-emitted as valid SSE. Logs `forced_tool_coerced` without content. Runs before the back-translation, so openai-chat clients get `tool_calls` / JSON `content` |
| `response_format` (structured output / JSON mode) | `openai-chat` → `anthropic` | **carried** as a forced tool call (`shared/structured-output-anthropic.ts`): `text` / absent → no constraint; `json_schema: {schema, description?}` → one tool `router_structured_output` whose `input_schema` is the schema, `json_object` → the same tool with `{type: "object"}`; `tool_choice: {type: "tool", name}` and `thinking: {type: "disabled"}` are stated, because a forced tool and thinking cannot share a request. The response half is a pure function of the upstream body: a `tool_use` of that name becomes `message.content` (its `input` as a JSON string, text beside it dropped), `finish_reason: "stop"` for `tool_use`, no `tool_calls`; streaming emits its `input_json_delta`s as `delta.content`. Refused `400`: `tools` beside `response_format` (the forced call leaves no room for the caller's tools), a schema root that is not `type: "object"`, a missing `json_schema` / `schema`, an unknown `type`, and any client tool named `router_structured_output` (reserved, whether or not `response_format` is set). `name` and `strict` are not carried. An upstream that ignores the forced tool answers in prose, and that prose reaches the caller unchanged. **Exception: a Claude subscription (`anthropic-oauth`) on the fast transport** (2.55.0, #370). Anthropic refuses a forced tool there for `claude-opus-5-5` and `claude-sonnet-5-5`, so `claude-fast/tool-choice.ts` sends the constraint as native `output_config.format` `{type: "json_schema", schema: <the tool's input_schema>}` instead. It is merged into any `output_config` already present, so an `effort` survives, and the body carries `tools: []` and no `tool_choice` or `thinking: disabled`. The answer is an ordinary text block, so it returns as `message.content` with `finish_reason: "stop"`, and as `delta.content` when streaming. The fast transport makes this choice, not the translator: translation runs before the invoker picks direct HTTP or its SDK fallback, and the SDK path still sends the forced tool ([claude-fast-mode.md](claude-fast-mode.md#forced-tool-choice)) |
| `response_format` (structured output / JSON mode) | `openai-chat` → `openai-responses` | **carried** as `text.format` (`shared/structured-output.ts`): `text` / absent → no constraint; `json_object` → `{type: "json_object"}`; `json_schema: {name, schema, strict?, description?}` → `{type: "json_schema", name, schema, strict?, description?}`, every value verbatim (the schema is the caller's own object). `name` is validated as OpenAI does (`^[a-zA-Z0-9_-]{1,64}$`) and defaults to `"response"` when omitted, since Responses requires one; a missing `schema`, a non-boolean `strict`, a non-string `description`, a non-object `json_schema`, or any other `type` is a `400` naming the field. The answer is ordinary `output_text`, so it returns as `message.content` unchanged; a refusal returns as `message.refusal` / `delta.refusal`. A schema the upstream itself rejects (e.g. Codex's `invalid_json_schema`) is the upstream's `400`, classified `client_error`. Lookaround `pattern`s are **not** stripped from this schema (only from tool schemas): dropping a constraint the caller will validate against is a different contract |
| Anthropic `output_config.format` / `output_format` (structured output / JSON Schema) | `anthropic` → `openai-chat`, `anthropic` → `openai-responses` | **refused** `400`, before any upstream call, naming the field the caller wrote — `output_format` or `output_config.format` (`assertNoAnthropicStructuredOutput`, `shared/reject.ts`). Anthropic's Messages API states the constraint as `output_config.format` (`{type: "json_schema", schema: {...}}`); `output_format` is its **deprecated** spelling, the one Anthropic's own `messages.parse(output_format=…)` helper takes and sends as `output_config.format` — the [wire record](../research/anthropic-structured-output.md). **No carrier exists for a constraint that starts in the `anthropic` dialect**: both carriers in this build run the other way (openai-chat → openai-responses as `text.format`, openai-chat → anthropic as a forced tool), so without the refusal the constraint would be dropped rather than degraded — the upstream would answer in prose and the caller's `JSON.parse` would fail naming nothing. The Agent-SDK column is not a translation hop; it is listed under [Agent-SDK egress](#agent-sdk-egress-claude-subscriptions). Absent and `null` state nothing and pass; an `output_config` without a `format` is the reasoning dial, which is carried. A **same-dialect** anthropic body on the **HTTP passthrough** (an `anthropic-api` account) is relayed untouched, the field intact — Anthropic enforces the constraint itself. A Claude subscription is nominally same-dialect but is a **re-synthesis**, not a passthrough, and drops the constraint silently ([Agent-SDK egress](#agent-sdk-egress-claude-subscriptions)) |
| Anthropic `temperature` / `top_p` | → `openai-responses`, **with reasoning on** | **carried** on `openai-api` (`anthropicToOpenAiResponsesRequest` forwards both verbatim), and the Responses API rejects them when a `reasoning` block is present, so that rejection is the upstream's, not the router's. On the Codex subscription path `CODEX_RESPONSES_EGRESS` drops `temperature`, `top_p` and `max_output_tokens` from every body the router translates, reasoning on or off; a same-dialect `/v1/responses` body is relayed untouched. Structured output is a separate rule: `text.format` and `response_format` other than plain text are refused `400` on every cross-dialect (translated) hop except openai-chat → openai-responses, which carries `response_format` as `text.format` (the rows above); a same-dialect body is relayed untouched |
| Tool-schema `pattern` containing a regex lookaround | → `openai-responses` on a surface with `stripLookaroundPatterns` (Codex) | **dropped and reported** by tool name and schema path, never by value; the backend compiles each `pattern` and refuses a lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`; a named group `(?<name>…)` is not one and is kept) with `400`. Walked: `items` (object and array form), `additionalItems`, `unevaluatedItems`, `prefixItems`, `additionalProperties`, `unevaluatedProperties`, `propertyNames`, `contains`, `contentSchema`, `not`, `if` / `then` / `else`, `anyOf` / `oneOf` / `allOf`, and the subschema values of `properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas` and `dependencies` (its property-list arrays are kept as they are). Data keywords (`default`, `enum`, `examples`, `const`) are never entered, and `patternProperties` regex keys are out of scope (reported paths use the entry's index, never the key). The substring test over-matches an escaped `\(?=` or a bracketed `[(?=]`. A tool whose schema text holds no lookaround anywhere is not walked. A walked schema nesting deeper than 64 levels, or walked schemas holding more than 10,000 subschemas across the whole request, is refused `400` (structural guards on the walk's own recursion and CPU, not tuning knobs). Same-dialect `/v1/responses` is relayed untouched |
| Tool calls against GPT-6 | `openai-chat` ↔ GPT-6 | The GPT-6 family accepts tool calls on the **Chat Completions** surface only when the client sent `reasoning_effort: "none"`. The router never produces that level itself: `openAiEffortFromAnthropic` passes a client's explicit `output_config.effort` through, buckets an `enabled` thinking budget into `low` / `medium` / `high`, and produces no level for `adaptive` or `disabled`. So an OpenAI account that must serve tools against a GPT-6 model speaks Responses. The Responses surface accepts tools with any reasoning effort, including none |
| `conversation`, `prompt`, `background: true` | `openai-responses` → any | **rejected** `400`, the same class as `previous_response_id` under three later names: turns the provider would prepend, instruction text stored provider-side, and a queued response to poll by id. `background: false` passes |
| Responses `reasoning` **input** items | → `anthropic`, `openai-chat` | dropped; a replayed summary is not visible assistant text. A nonempty `encrypted_content` is dropped and **reported** (`input[n].encrypted_content`), and `include: ["reasoning.encrypted_content"]` with it; any other `include` entry and every `item_reference` remain rejected `400` |
| Responses `reasoning` **output** summary | → `anthropic` | **carried** as a `thinking` block signed `mar1:` (router tag, no secret), or — under the serving account's reasoning seal — signed with the sealed encrypted handle (`redacted_thinking` when there is no summary) and replayed to that account only; see [above](#streaming-sse-event-mapping). Toward `openai-chat` dropped — no *published* field; the extension names are read from an upstream, never written toward a client |
| Anthropic `thinking` blocks | → `openai-responses` | carried as a reasoning **summary** item; the encrypted reasoning handle is not synthesized |
| Replayed `thinking` / `redacted_thinking` blocks (request) | anthropic → `openai-responses` | replayed in place as a `reasoning` input item only when the selected account's seal opens the signature (a handle that account issued); every other block is dropped |
| openai-chat `reasoning_content` / `reasoning` | → `openai-responses` | **carried** as a reasoning **summary** item. Both spellings are read — DeepSeek's and OpenRouter's — and `reasoning_content` wins if an upstream states both. See [above](#streaming-sse-event-mapping) |
| openai-chat `reasoning_content` / `reasoning` | → `anthropic` | **carried** as a `thinking` block signed `mar1:`, stream and non-stream, the same as a Responses summary; dropped again by every `anthropic → X` request translator on replay. Residual: a transcript moved to a real Anthropic upstream through passthrough is refused `400` on the foreign signature. See [above](#streaming-sse-event-mapping) |
| Anthropic `output_config.effort` | → any OpenAI dialect | **carried** as `reasoning_effort` / `reasoning.effort`, verbatim: `low`, `medium`, `high`, `xhigh`, `max` are words of both vocabularies |
| Anthropic `thinking` request parameter | → any OpenAI dialect | with no `output_config.effort`, an `enabled` budget lands in a bucket — `budget_tokens` ≤ 4 096 → `low`, ≤ 16 384 → `medium`, above → `high` (Claude Code's `think` / `megathink` / `ultrathink` presets land one per bucket). `adaptive` and `disabled` name no level and send none (`none` is not sent: several OpenAI reasoning models refuse it). Toward `openai-chat`, an `enabled` / `adaptive` `thinking` beside a `tool_choice` that still forces a tool after translation (`any` / `tool`) is **dropped and reported** (`thinking`) and sends no bucket: Anthropic refuses that pair, and so do compatible chat vendors (Qwen: `400` "The tool_choice parameter does not support being set to required or object in thinking mode", ~200 a week from the AI SDK's forced `json` tool, prod 2026-10-16). The force wins, as it does on `openai-chat-to-anthropic`; an explicit `output_config.effort` is not thinking and still travels. Toward `openai-responses` the pair is carried (OpenAI and Codex serve it). Toward `openai-responses`, `enabled`/`adaptive` or a stated effort also sets `reasoning.summary: "auto"`, so the summary can travel back as a `thinking` block |
| Forced `tool_choice` to a think-by-default openai-chat vendor | anthropic / openai-chat → `openai-chat` | **`enable_thinking: false` emitted** (`shared/thinking-default.ts`, applied at the per-attempt model reapply in `dataplane/translate-body.ts`) when the surviving `tool_choice` forces a tool **and** the upstream (post-alias) model id matches `OPENAI_CHAT_THINKING_DEFAULT_MODELS`. Dropping a client-sent `thinking` is not enough for these vendors: Qwen's "3.8" hybrid series (`qwen3.8-max`, `qwen3.8-flash`) reasons unless the body states this dial, and its OpenAI-compatible endpoint `400`s a forced tool in thinking mode (~284/week, prod; `docs/research/thinking-and-tool-choice.md`). The dial is a plain top-level body field DashScope reads, **not** OpenAI-standard — a vanilla OpenAI / Codex endpoint `400`s on an unknown field — so it is emitted **only** for a matched model, **only** on openai-chat egress, **only** beside a forced tool, and never toward `openai-responses`. The set is **config** (non-negotiable 11), empty by default; the suggested deployment value is `qwen3.8-max,qwen3.8-flash` (exact ids, or a trailing-`*` prefix glob such as `qwen3.8-*`). It is a vendor dial, never a model change (non-negotiable 4) |
| `reasoning_effort` ⇄ `reasoning.effort` | `openai-chat` ⇄ `openai-responses` | **carried**, verbatim and both ways: OpenAI's own spec points both fields at one shared `ReasoningEffort` schema, so they are the same dial one level of nesting apart. The word is never validated against a list of ours — that set is `none \| minimal \| low \| medium \| high \| xhigh \| max` today, has grown twice past the four everyone remembers, and `none` means "do not think" rather than "invalid". Refusing a word the upstream accepts would be the router deciding how the model behaves |
| `reasoning.effort` / `reasoning_effort` | `openai-responses` / `openai-chat` → `anthropic` | **carried** as `output_config.effort` — the same dial under Anthropic's name. Clamped only where Anthropic has no such word: `minimal` → `low`; `none` → `thinking: {type: "disabled"}`. A word in neither table is dropped and **reported**; the upstream default applies. A clamp moves a dial, never the model (non-negotiable 4) |
| `prompt_cache_key` | `openai-chat` → `openai-responses` | **carried**, verbatim — both OpenAI dialects spell the field identically, and the first-party Codex CLI sends it on every request. Absent, `null` or `""` states none: toward a cache-keyed surface (`cacheKeyHeader`, Codex; or `bodyCacheKey`, `openai-api` and `openrouter`) the router then sends a key derived from the session key (`sessionCacheKey`, `dataplane/egress/cache-key-header.ts`), which every Anthropic-ingress request needs since that dialect has no such field (prod 2026-10-17: 17.4% cache-read share on Codex vs 91–96% on passthrough vendors); toward any other upstream none is sent. Toward a keyed surface the caller's own key wins even from a conversion that has no field to carry it (`openai-responses` → `openai-chat`, `translate-body.ts`). A surface that also states `bodySessionId` (`openrouter`) gets the same key as a body `session_id` (at most 256 characters, OpenRouter's limit; a longer caller key travels in `prompt_cache_key` alone), so provider stickiness starts on the first turn rather than at the first observed cache hit. A same-dialect body is never touched: it keeps whatever key the client wrote. Toward `anthropic` dropped: Anthropic caches by `cache_control` breakpoints and states no key. Dropping it made every step of a conversation a cold prefill on Codex (prod 2026-10-16: 16–22% of input read from cache against 98.5% for the same turns via OpenRouter) |
| `reasoning.summary` | `openai-responses` → any | dropped. It asks the *provider* to write a summary of its own reasoning, and no other dialect states the request |
| `parallel_tool_calls` / `tool_choice.disable_parallel_tool_use` | all dialect pairs | **carried** between OpenAI dialects; inverse boolean toward/from Anthropic. An absent field stays absent; with nonempty tools, an explicit OpenAI policy without a tool choice maps to Anthropic `type: "auto"`. When tools are absent or empty, the policy alone does not synthesize a choice; an explicit caller choice is preserved |
| `input_image` naming only a `file_id` | `openai-responses` → any | rejected `400`: a stored file is provider-side state this router cannot resolve into bytes |
| `max_tokens` / `max_completion_tokens` | → `openai-chat` | not lossy, but **not one name either** — emitted under whichever of the two the selected Account accepts. See [The output ceiling](#the-output-ceiling-one-field-two-names) |
| Responses item ids | → `openai-responses` | minted by the router from the response id and the item's position — deterministic, but not the provider's own |
| Beta headers (`anthropic-beta`) | → non-Anthropic, and on the Agent-SDK path | dropped |
| `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`, `n`, `logprobs`, penalties | → `agent-sdk` | **accepted and silently inert** — `query()` has no equivalent for any of them, so a value the caller set has no effect on the request. `reasoning_effort` / `reasoning.effort` is the exception: translated to `output_config.effort` like any Anthropic target (`minimal` → `low`, `none` → thinking disabled), then read onto the SDK's effort scale (`low`…`max`) |

**Silently dropping a parameter the caller set is a correctness trap, so the router does not stay
quiet about it.** Every field a conversion drops that the caller would want to know about — a tool,
a document, a block — is reported by the translator through an injected drop sink
(`services/translate/shared/drops.ts`; the translator stays pure and never logs) and written by the
transport as one `translation dropped fields` warn line per conversion, naming ingress, egress, the
count, and each field with its structural reason. Documented *hints* (`top_k`, `cache_control`, a
thinking block) are not reported: every request carries some, and a line per request says nothing.
A response-level surface — a warning field or header the *caller* can read — is still **DEFERRED**. It also compounds: current Anthropic models reject
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

## Surface rules

The Responses dialect is one wire shape, but an upstream speaking it may accept less than all of it.
The ChatGPT Codex backend (`openai-oauth`) refuses a request that is not `stream: true`, one with no
`instructions`, and the `max_output_tokens`, `temperature` and `top_p` fields its first-party client
never sends — each a `400`, so a translated request otherwise fails outright. Like the output
ceiling, that is a fact about the **provider**, declared once in its driver as a
`ResponsesEgressRules` value (`CODEX_RESPONSES_EGRESS` in `providers/drivers/openai-oauth.ts`), and
handed to the translator per candidate as `TranslationContext.responsesEgress`. No provider name is
tested anywhere under `services/translate/`.

| Rule | Effect on a body the router wrote |
|---|---|
| `requireStream` | `stream: true`, whatever the client asked |
| `requireInstructions` | `instructions: ""` when the client sent no system prompt |
| `unsupportedFields` | each removed, and reported as a drop by name (never by value) — except a field the ingress dialect puts on every request: Anthropic's mandatory `max_tokens` (`max_output_tokens`) is removed silently on anthropic ingress, a documented hint like `top_k` (one warn line per Claude Code turn said nothing: 174 an hour, prod 2026-10-16). A ceiling an openai-chat caller chose is still reported |
| `stripLookaroundPatterns` | a `pattern` containing a regex lookaround is removed from every walked tool-schema position and reported by tool name and schema path; non-lookaround patterns and data keywords are kept (`shared/schema-lookarounds.ts`) |
| `cacheKeyHeader` | the header the upstream derives prompt-cache affinity from (Codex: `session-id`). The one rule that also applies to a **byte relay**, because it touches no body byte: a translated request sends the `prompt_cache_key` its body carries under it (the caller's, else the session-derived one), a relay forwards the client's own header of that name (otherwise stripped at the trust boundary, `dataplane/egress/headers.ts`). An unbound session and no caller key, or a key no header can carry, sends none; a driver header is never overridden (`dataplane/egress/cache-key-header.ts`) |

A client that did **not** ask to stream is still owed one JSON body. The forced upstream stream is
read to its end and folded back into one Responses object (`collectResponsesStream`: the terminal
event's response, its `output` rebuilt from `response.output_item.done` when the snapshot omits it),
which the ordinary non-streaming response translator then converts. Reading it whole delays nothing:
there was never a stream to forward to that client.

**Same-dialect `/v1/responses` is untouched** — a byte relay is never parsed to apply these rules (`cacheKeyHeader` reads a client header, never the body)
(non-negotiable 10). A Codex client already sends what Codex accepts; a generic Responses client
pointed at a Codex account gets the upstream's own `400`.

**Wiring.** The driver's surface declares the rules (`ProviderSurface.responsesEgress`, read through
`resolveResponsesEgress` — pure, in memory, no store on the critical path); `dataplane/plan.ts`
resolves them per candidate beside `chatCeiling`; `translate-body.ts` hands them to the translator
and keys its conversion cache on them; `chain-relay.ts` asks `relay-translate.ts` to collect only
when the rules force a stream **and** the client did not ask for one. A client that asked to stream
is forwarded event by event, exactly as on any other translated account. Usage is read from the
upstream's own bytes either way, so a collected response records its tokens like any other. A
forced stream that ends without a terminal event fails as `translation_protocol_error` after the
response has started — never retried onto another account.

**A forced stream is read as SSE because the driver said so, not because a header did.** The Codex
backend answered `200` with an event stream and **no `content-type`** (prod, 2026-10-04); keyed on the
header, the relay forwarded the raw Responses frames to a streaming Anthropic client (zero Anthropic
events) and the same raw SSE to its non-streaming retry. So for a translated candidate whose rules
force a stream, the request sends `Accept: text/event-stream` (as codex-rs does) in place of the
client's own `Accept`, the relay and the usage observer treat the body as SSE whatever its
`content-type`, and the client's response states its own `content-type` — `text/event-stream` when
forwarded, `application/json` when collected. The admin **Test now** probe follows the same rules,
and sends `input` as a list of message items: the Codex backend refuses the string shorthand with
`400 Input must be a list`.

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

An Account declaring **nothing** serves its provider's model family where the driver declares one (a
Claude or ChatGPT subscription — [05-routing-and-failover.md](05-routing-and-failover.md#candidate-filtering)),
and everything otherwise: unknown is passthrough, not exclusion. It
contributes no enumerable name beyond its alias keys, so a deployment of only such Accounts lists
nothing rather than inventing a catalog it cannot stand behind — which is why the operator is given
`POST /api/admin/accounts/:id/models/discover`, one free `GET` at the provider's own listing, to fill
the declaration in. A Claude subscription is the exception, for the reason given under
[Ingress surface](#ingress-surface): it has no listing to discover from, so what its Agent SDK
handshake reports is what it lists.

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
| Fail loud, never degrade | A request whose *contract* cannot be carried — a stop sequence with no target, a structured-output constraint on a hop that cannot carry it, a stateful Responses field — returns a clear `4xx` naming the offending field, before any upstream call; so does a body that is not a valid request in its own dialect. A field the target merely cannot *represent* — a server-side tool, a PDF, a block type — is dropped **and reported by name** rather than refused: the request is served with what the target can read, and the operator's log says what it could not. Silently dropping either is a bug; dropping a documented *hint* is listed above. |
| One direction at a time | Each translator is written and tested per direction. "Round-trips" are not assumed to be lossless and are not asserted. |

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Where the translation decision sits in the request lifecycle |
| [03-providers.md](03-providers.md) | Which dialect each provider speaks natively |
| [05-routing-and-failover.md](05-routing-and-failover.md) | How the account — and therefore the egress dialect — is chosen |
| [07-security.md](07-security.md) | What may never appear in a translated error body |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | The Agent-SDK path in full: why, mechanics, per-Account config dirs |
