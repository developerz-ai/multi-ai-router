# Claude subscription fast mode

`CLAUDE_FAST_MODE=true` is the default. Set it to `false` to force every Claude
subscription request through the Agent SDK. Fast mode uses direct Messages HTTP
for warm Claude subscription inference, avoiding a Claude subprocess for each request.
This is a router transport setting; it does not select Anthropic's paid fast inference tier.

## Authentication and fallback

Continue setting up accounts through the existing SDK/CLI login flow. The SDK alone owns
refresh and background credential keepalive. Fast inference reads the selected account's
`.credentials.json` and `.claude.json` under its metadata ownership fence, never HOME or another
account directory. Credentials are read after concurrency admission so a queued request cannot reuse a stale
pre-queue snapshot. The access token is used only for the fixed Anthropic HTTPS endpoint.
Client authentication headers are discarded; redirects are refused and provider error prose
is replaced with safe router-authored messages.

Missing identity, missing credentials, expiry within the CLI's five-minute refresh lead,
unresolved model aliases, or an unknown native wire version cause SDK fallback **before** HTTP
inference starts. SDK fallback answers that request; the following warm request can be direct.
There is no SDK retry after direct inference begins. Normal router failover remains responsible
for upstream failures and never retries after response bytes reach the client.

The calibrated profile is CLI `2.1.319`, SDK `0.3.319`, Bun `1.4.4`. A custom CLI override,
a different Bun version or SDK manifest, or a binary SHA-256 differing from the captured Linux x64
glibc build disables
the direct transport at boot and emits a warning. The check accepts the image's staged PATH copy
after dependency pruning and hashes in bounded chunks, once at boot. The build stages the SDK
manifest alongside the bundled artifacts because workspace package links are absent in the image;
a final-image gate checks availability before publication. Boot logs distinguish verified direct
inference from SDK fallback and include safe fallback reason codes. Recalibrate before upgrading these pins.
Concrete `claude-*` model IDs pass through; aliases require a live SDK catalog resolution.
The `[1m]` model suffix becomes the corresponding beta header, without model substitution.

## Histories, agents and caching

Clients must resend complete histories, including their own compacted summaries. Fast mode does
not resume SDK transcripts or execute an agent loop on the router. Client-managed subagents can
run concurrently with independent histories; the existing global/per-account concurrency bounds
still apply. SDK session lineage is disabled for this transport. Account selection, key scopes,
request deadlines, usage accounting and quota cooling retain the shared router pipeline.

Tool definitions, names, calls/results, thinking signatures, per-turn system messages and unknown
protocol fields are preserved, except for a forced tool choice
([Forced tool choice](#forced-tool-choice)). Tools execute at the client; no host tools are added or run.
Native attribution preserves subagent markers, task-notification origins, previous-request IDs
and omitted helper origins. Generic requests receive the captured interactive CLI envelope.
Session identity is derived from account, router key and client session, so replicas agree and
separate tenants do not share upstream identities. This differs from replaying a native session
identifier. Missing native counters are derived from history and cannot reproduce hidden CLI state.

Explicit cache controls survive unchanged, including helper `5m` TTLs. If none are supplied,
fast mode adds up to three native-style `1h` breakpoints to the identity/system prefix and last
message. Existing thinking blocks are not assigned cache controls. Upstream cache usage counters
remain available to normal accounting. Streaming calls relay upstream SSE without folding;
nonstream calls fold it to a Messages response and refuse incomplete or malformed event
lifecycles. Both paths require an SSE media type and a response body before accepting HTTP success;
proxy HTML/JSON cannot masquerade as successful inference. Valid streaming bodies remain unchanged.
A completed upstream refusal, including empty content and zero output tokens, remains a valid
Messages response with its refusal stop reason/details; it is not retried as a transport fault.

## Evidence and rollout

Interactive wire calibration should use `bin/claude-trace pty --model <concrete-model>` or the
manual `tty` scenario. PTY launches the native interactive CLI, retains its system prompt,
removes inherited entrypoint overrides, and verifies `cc_entrypoint=cli` in captured requests.
Use `--prompt-stdin` for a scripted one-turn prompt and `--private-wire` for exact private bodies.
Print/SDK traces are separate comparison arms. Direct fast inference already emits `cli`;
SDK fallback can still emit an SDK entrypoint. The entrypoint reports in
[Claude Code #97074](https://github.com/anthropics/claude-code/issues/97074) motivate checking the
actual wire label, but do not establish quota parity for this router. See the
[capture procedure](../research/claude-wire.md#repeat-after-an-sdkcli-update) for startup
requirements, completion checks and private artifact handling.

The [wire record](../research/claude-wire.md) distinguishes observed TTY, print, SDK, tool,
subagent, notification and compaction behavior from reconstruction. The checksum matched 22/22
private captures for CLI `2.1.301` and 15/15 for CLI `2.1.319` on 2026-11-07, with the same
per-version seed and suffix algorithm. A local CLI/Bun comparison matched ClientHello fingerprints
and header order. These results do not establish identical production behavior or
account-enforcement outcomes.
The initial RSS observation was about 265 MiB for the CLI process; a controlled router memory/
latency benchmark across accounts is still required before claiming a measured improvement.

Each infrastructure repository pins the released image and explicitly configures
`CLAUDE_FAST_MODE`. Publish and verify the image using each repository's normal GitOps process,
then validate the selected deployment's cache hits, quota headers, tool rounds, truncations and
concurrent-history behavior. The local MITM/HTTP canary evidence is recorded in the
[wire research](../research/claude-wire.md#fast-mode-recalibration-2026-11-07); deployed health
and inference checks remain necessary after enabling the flag.
Rollback is `CLAUDE_FAST_MODE=false` and a normal rollout. No credentials need migration.

## Live direct canary, 2026-10-16

Two production-invoker calls against the explicitly selected debug account and `claude-opus-5-5`
returned HTTP 200. The model emitted a synthetic `trace_echo` call, the client supplied its result,
and the second response retained `TRACE_42`. The first call created 12,929 one-hour cache tokens;
the second reported 12,929 cache-read tokens and zero cache creation. Four quota-window readings
were delivered. No host tools or SDK inference were used. This is an invoker canary, not an
end-to-end deployed-router benchmark or a cross-account soak test.

That model rejected `tool_choice: tool`/`any` with 400; automatic choice completed the round trip.
Through 2.54.2 fast mode forwarded the caller's choice anyway. Since 2.55.0 it adapts the choice
([Forced tool choice](#forced-tool-choice)). The separate offline tests cover streaming byte
preservation, cancellation, truncation, errors, identity isolation and SDK fallback.

## Forced tool choice

**Evidence.** A prod replay ran on 2026-11-09 against router 2.54.2 through fast mode, with one
attempt per row, using a key scoped to one subscription account (issue #370, checkpoint 1):

| Request | opus-5-5 | sonnet-5 | sonnet-5-5 |
|---|---|---|---|
| `/v1/messages`, `tool_choice {type:"tool"}` + `thinking {type:"disabled"}` | 400 | 200 `tool_use` | 400 |
| the same without `thinking` | 400 | | |
| `tool_choice {type:"auto"}` | 200 `tool_use` | 200 | 200 |
| `output_config.format` json_schema, no tools | 200 JSON text | 200 | 200 |
| `/v1/chat/completions` + `response_format` json_schema | 400 | 200 | 400 |

The force itself is what is refused, not `thinking`. Every 400 reached the client as "the upstream
rejected the request as malformed", with no `error.router` and with Anthropic's own text logged
nowhere.

**Behavior** (`tool-choice.ts`, a pure function `prepareFastRequest` calls after it copies the
client's fields):

- `{type:"tool", name}` keeps only that tool. `{type:"any"}` keeps every declared tool. Both send
  `{type:"auto"}` (keeping `disable_parallel_tool_use`) and remove a `thinking {type:"disabled"}`,
  which only existed to permit the force. Fast mode never adds one.
- The router's structured-output tool `router_structured_output` (the openai-chat `response_format`
  carrier, `translate/shared/structured-output-anthropic.ts`), when it is the only tool, is sent as
  native `output_config.format` `{type:"json_schema", schema}` instead, but only when every object
  node of the schema states `additionalProperties: false` (`native-schema.ts`: the root and every
  schema under properties, items, combinators, `$defs`/`definitions` and `additionalProperties`).
  It is merged into any existing `output_config`, and sent with `tools: []` and no `tool_choice`.
  The answer is ordinary text, which the openai-chat renderer returns as `message.content`.
- Any other structured-output schema stays the adapted forced tool from the first bullet. That
  includes `json_object`, whose schema is a bare `{type:"object"}`. Anthropic refuses such a
  schema natively: a local 2.55.0 router against a real subscription (claude-opus-5-5, 2026-11-09)
  got `400` `output_config.format.schema: For 'object' type, 'additionalProperties' must be explicitly set to false`. The tool's `tool_use` input still returns as `message.content` with
  `finish_reason: "stop"`, and the non-streaming forced-tool-unmet check applies.
- Unchanged, so the upstream refuses them as before: a forced name the request does not declare,
  and `any` with no tools. `auto`, `none` and an absent choice are byte-unchanged.
- A non-streaming answer to a relaxed force with no `tool_use` block fails as
  `claude-sdk:forced-tool-unmet`: `502`, retryable on another account, the same sentence and rule
  as the Agent-SDK transport. Streaming answers are not checked, also matching the SDK. On a model
  that would have honored the force (sonnet-5), that means a streaming turn loses the hard
  guarantee.

The choice is made here, not at translation. The translator runs before the invoker chooses direct
HTTP or its SDK fallback, and the SDK transport enforces a forced tool itself (`createPassthrough`).
Only the vendor `thinkingOnByDefault` drivers keep their own forced-tool handling, and it is
unchanged.

**Refusals.** A fast-path `invalid-request` reaches the client as the router's
`InvalidRequestError`, carrying `error.router` with `wall: "request"`, in every dialect. Anthropic's
text, with the account's token and pattern-shaped credentials redacted, goes only to the attempt
warn line, as `upstreamMessage`. Other statuses keep their verdict and also log that text.
