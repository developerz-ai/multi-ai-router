# Claude subscription fast mode

`CLAUDE_FAST_MODE=false` is the default. Set it to `true` to use direct Messages HTTP
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

The calibrated profile is CLI `2.1.301`, SDK `0.3.301`, Bun `1.4.2`. A custom CLI override,
a different Bun version or SDK manifest, or a binary SHA-256 differing from the captured Linux x64
glibc build disables
the direct transport at boot and emits a warning. The check accepts the image's staged PATH copy
after dependency pruning and hashes in bounded chunks, once at boot. Recalibrate before upgrading these pins.
Concrete `claude-*` model IDs pass through; aliases require a live SDK catalog resolution.
The `[1m]` model suffix becomes the corresponding beta header, without model substitution.

## Histories, agents and caching

Clients must resend complete histories, including their own compacted summaries. Fast mode does
not resume SDK transcripts or execute an agent loop on the router. Client-managed subagents can
run concurrently with independent histories; the existing global/per-account concurrency bounds
still apply. SDK session lineage is disabled for this transport. Account selection, key scopes,
request deadlines, usage accounting and quota cooling retain the shared router pipeline.

Tool definitions, names, calls/results, thinking signatures, per-turn system messages and unknown
protocol fields are preserved. Tools execute at the client; no host tools are added or run.
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

## Evidence and rollout

The [wire record](../research/claude-wire.md) distinguishes observed TTY, print, SDK, tool,
subagent, notification and compaction behavior from reconstruction. The checksum matched 22/22
private captures. A local CLI/Bun comparison matched ClientHello fingerprints and header order.
These results do not establish identical production behavior or account-enforcement outcomes.
The initial RSS observation was about 265 MiB for the CLI process; a controlled router memory/
latency benchmark across accounts is still required before claiming a measured improvement.

Each infrastructure repository pins the released image and explicitly configures
`CLAUDE_FAST_MODE`. Publish and verify the image using each repository's normal GitOps process,
then validate the selected deployment's cache hits, quota headers, tool rounds, truncations and
concurrent-history behavior. The local MITM/HTTP canary evidence is recorded in the
[wire research](../research/claude-wire.md#follow-up-mitm-audit-2026-10-16); deployed health and
inference checks remain necessary after enabling the flag.
Rollback is `CLAUDE_FAST_MODE=false` and a normal rollout. No credentials need migration.

## Live direct canary, 2026-10-16

Two production-invoker calls against the explicitly selected debug account and `claude-opus-5-5`
returned HTTP 200. The model emitted a synthetic `trace_echo` call, the client supplied its result,
and the second response retained `TRACE_42`. The first call created 12,929 one-hour cache tokens;
the second reported 12,929 cache-read tokens and zero cache creation. Four quota-window readings
were delivered. No host tools or SDK inference were used. This is an invoker canary, not an
end-to-end deployed-router benchmark or a cross-account soak test.

That model rejected `tool_choice: tool`/`any` with 400; automatic choice completed the round trip.
Fast mode preserves the caller's choice and native upstream validation rather than silently
changing model capabilities. The separate offline tests cover streaming byte preservation,
cancellation, truncation, errors, identity isolation and SDK fallback.
