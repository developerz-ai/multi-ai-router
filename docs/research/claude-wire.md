# Claude wire research and repeatable MITM workflow

Observed 2026-10-16. This is a research record, not a claim that a replacement transport
is indistinguishable from Claude Code or immune to account enforcement. The opt-in router
transport is described in [fast mode](../idea/claude-fast-mode.md); both deployments start disabled.

## Versions and evidence

- Agent SDK: `0.3.301`, upgraded from `0.3.289` in `apps/api/package.json` and `bun.lock`.
- Claude Code: `2.1.301`, Linux x64, the native executable published by Anthropic.
- The observed executable's SHA-256 matches the SDK manifest:
  `bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222`.
  Size: `267955384` bytes. No binary modification was performed.
- Runtime reported by the native client: Node `v26.3.0`; Stainless package `0.128.0`.
- MITM proxy: `12.2.3`, bound to loopback. Extra CA trust applies only to the traced process;
  TLS verification is not disabled and no CA is installed system-wide.
- Active local research: `tmp/claude-http/`. This directory is gitignored. The older scratch
  contents were removed at the user's request (255 entries, approximately 989 MB beforehand).
- `cli.jsonl` is the initial local capture, `*-events.jsonl` holds SDK events, and
  `wire-bodies.jsonl` holds later exact bodies without authentication headers. These initial
  files contain private prompts/identifiers and must not be committed or shared.
- New reproducible runs use `tmp/claude-http/runs/<timestamp>-<mode>/manifest.json`,
  `flows.jsonl`, `proxy.log`, and optionally `private-bodies.jsonl`.

The first capture buffered responses in the debugging proxy. It establishes request and
response shape, not native timing. The committed capture addon forwards each response chunk
immediately, unchanged, while keeping a bounded copy for analysis. Even its timings include
the proxy and cannot establish the router's production overhead.

## Repeat after an SDK/CLI update

`bin/claude-trace --help` describes the live diagnostics. They require Bun, Python 3, `uv`,
`claude` and an existing Claude login. `uv` obtains the pinned proxy in its own tool environment;
no Python dependency is installed into the router. These commands make real, billed requests.
They are deliberately absent from CI and `bin/test`.

Choose the same concrete model for comparisons. Model names are explicit; the diagnostic
never quietly selects a smaller model. Keep the account, tool catalog, settings, prompt,
thinking/effort and cache TTL constant when testing an entrypoint hypothesis.

```sh
bin/claude-trace print --model claude-opus-5-5
bin/claude-trace sdk --model claude-opus-5-5
bin/claude-trace conversation --model claude-opus-5-5
bin/claude-trace subagents --model claude-opus-5-5
bin/claude-trace autocompact --model claude-opus-5-5
bin/claude-trace tty --model claude-opus-5-5
bin/claude-trace analyze tmp/claude-http/runs/<run>/flows.jsonl
```

Use `--config-dir /absolute/path` to select one isolated account. Omit it to use the CLI's
normal login; do not point it at a different directory and expect the same credential lookup.
`--cli /absolute/path/to/claude` pins the executable. Record the installed SDK and CLI versions
from the run manifest every time; upgrading one does not prove the other was upgraded.

Default captures redact prompt/reply text, private headers, account/device identifiers,
request IDs, tool inputs and signatures. Stable local surrogate IDs preserve equality and
parent/child correlations without publishing real identifiers. Cache controls, usage,
quota headers, protocol roles, billing field names and entrypoint enums remain inspectable.

For checksum work, explicitly add `--private-wire`. The additional file contains exact request
body bytes as base64, including private prompts and metadata, but never authentication headers.
Files are mode `0600`, run directories `0700`. Do not upload private-wire artifacts. Login and
OAuth token-exchange payloads are outside the capture allowlist.

The diagnostic denies shell/filesystem tools. Its optional MCP tool only echoes a synthetic
marker. The arithmetic subagent has an empty tool list. This research does not relax the
router's production tool allowlist or subprocess isolation.

## Keyboard scenario

Run `tty` in a real terminal, not `-p` with an artificial flag. Type these separately:

1. `Remember marker TRACE_42. Reply briefly.`
2. `Reply with only the remembered marker.`
3. `/context`
4. `/usage`, then Escape to close the panel.
5. `/compact Keep marker TRACE_42.`
6. `After compaction, reply with only the remembered marker.`
7. `Use the trace echo_marker MCP tool to echo TRACE_42 and report its result.`
8. `Use Agent to ask trace_worker for 19 + 23. Actually delegate, then report its result.`
9. Ask for two independent arithmetic subagents and wait for both (verified in the initial TTY
   investigation: both completed, each returned 42, and the marker survived).
10. Exit normally after all background agents finish.

For TTY autocompaction, use a dedicated process with a deliberately lowered threshold; never
change the user's persistent settings. The initial investigation set the CLI's own
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1` only in that process, supplied synthetic context, then ran
a tool round trip. The reproducible `autocompact` SDK scenario uses that same process-local
threshold and multiple turns. A threshold crossing before enough message groups exist emits
`too_few_groups`; that is a refusal to compact, not evidence of a successful compact.

In PTY automation, bracketed paste followed by a separate Enter was reliable. A pasted carriage
return sometimes triggered the CLI's invisible-character review instead of submitting, so
waiting for an actual HTTP request matters. Sending text is not proof it was processed.

## Confirmed entrypoint differences

All three main paths posted to `https://api.anthropic.com/v1/messages?beta=true` and used
OAuth Bearer authentication from the same logged-in account.

| Field | Keyboard TTY | `claude -p` | Agent SDK `query()` |
|---|---|---|---|
| User-Agent suffix | `(external, cli)` | `(external, sdk-cli)` | `(external, sdk-ts, agent-sdk/0.3.301)` |
| Billing `cc_entrypoint` | `cli` | `sdk-cli` | `sdk-ts` |
| Human-submitted turn origin | `human` | `sdk` | `sdk` |
| Initial prompt index | `1` | `0` | `0` |
| Identity prefix | Official Claude Code CLI identity | Claude Agent SDK identity | Claude Agent SDK identity |

TTY identity text was `You are Claude Code, Anthropic's official CLI for Claude.`
The noninteractive custom-system-prompt traces used
`You are a Claude agent, built on Anthropic's Claude Agent SDK.`

The identity also depends on whether the caller uses an appended system prompt or a replacement
system prompt; the current binary contains three recognized identity variants. The table
records the options actually tested, not every SDK configuration.

Other observed request headers include `anthropic-version: 2023-06-01`, `x-app: cli`,
`anthropic-dangerous-direct-browser-access: true`, `X-Claude-Code-Session-Id`,
`x-claude-code-prompt-id`, `x-client-request-id`, and `X-Stainless-*` runtime details.
Record their presence and their relationships, not a copied set of somebody else's IDs.

The beta set is dynamic: the observed main requests included OAuth, Claude Code, interleaved
thinking, thinking token count, context management, prompt caching scope, per-turn control,
mid-conversation tool/system changes, effort, thinking binding, extended cache TTL and cache
diagnosis. Some calls added thinking display updates, dangerous-tool-use safeguards or AFK.
Subagent, compaction and title-helper requests can have different subsets. A single hardcoded
beta string is not evidence of parity across all request classes.

Main request envelopes contained `model`, `messages`, `system`, `tools`, `metadata`,
`max_tokens`, `thinking`, `context_management`, `output_config`, `diagnostics`, and `stream`.
Some CLI modes also added `safeguards`. Main requests streamed SSE even when `-p` returned
one final JSON object to its caller. That final CLI JSON is a harness result, not the upstream
Messages response.

## Back-and-forth and prompt caching

- Follow-up requests carried conversation history, including assistant messages and tool results.
  A session ID alone does not instruct the Messages endpoint to restore hidden history.
- `system` is also a mid-conversation message role in this CLI version. Environment/date,
  per-turn output configuration and token-budget updates appeared there; they were not all
  flattened into the top-level system prompt.
- Explicit cache controls appeared on stable system blocks and the newest cacheable message
  block. Earlier message markers were removed as the boundary moved forward. The main trace
  used `{type: "ephemeral", ttl: "1h"}`.
- The changing billing attribution block was not itself an explicit cache breakpoint.
- Native thinking blocks/signatures, tool schemas and ordering must survive a round trip.
  Flattening tool results into text or rewriting the history changes the cached prefix.
- Reuse was measured, not inferred from the presence of markers: one follow-up reported
  `cache_read_input_tokens=27256` and `cache_creation_input_tokens=421`; a later short-history
  follow-up reported `cache_read_input_tokens=1721` and `cache_creation_input_tokens=89`.
- A TTY `/usage` panel reported a warm one-hour prompt cache. Small cold requests can report
  no cache reads; that alone does not establish broken caching.
- A direct HTTP experiment returned `200` with `DIRECT_OK`. Its tiny prompt had zero cache
  reads/writes. This proves one accepted request, not parity or production readiness.

## Subagents and asynchronous completion

Both SDK and TTY subagent tests actually invoked Agent, computed `19 + 23`, and returned `42`.
The TTY also completed a synthetic MCP call with a matching `tool_use` / `tool_result` pair.

Important: in the TTY trace, the subagent's `metadata.user_id` decoded to the **same**
`device_id`, `account_uuid`, and `session_id` as its parent. It had a separate, shorter
message history and `cc_is_subagent=true` in billing attribution. Parent and child shared the
prompt ID for that delegation. Never assume `metadata.session_id` uniquely identifies a
subagent conversation.

The parent emitted `tool_use` for Agent. A background launch first returned a placeholder
`tool_result`; completion arrived later as a task notification. The additional parent request
used `cc_turn_origin=task_notification`, with the prompt index unchanged and the turn index
advanced. A user-origin request can therefore create more than one API turn.

A router serving a concurrent agent harness must preserve each supplied history, tool-call
correlation and model, while keeping account selection within key scope. Do not merge separate
histories just because they share metadata. Do not execute the client's tools on the router.
These requirements also cover Hive Mind-style coordinators and parallel workers; private
application implementation details are not part of this public research record.

## Manual and automatic compaction

- `/compact` caused an additional Messages call. It carried summary instructions and the old
  conversation, then later requests used the summary plus a preserved suffix.
- The summary call's attribution omitted `cc_turn_origin`, prompt index and turn index in the
  observed case. It retained linkage to the previous request. It was not another human turn.
- A successful SDK manual compact emitted a `compact_boundary` with `trigger: manual`.
- A successful forced SDK autocompact emitted `trigger: auto`, `pre_tokens: 27737`,
  `post_tokens: 909`, `cumulative_dropped_tokens: 26828`, and a list of preserved message UUIDs.
- A real TTY autocompact completed during the synthetic MCP round trip; the tool result and
  remembered marker survived. Manual TTY compaction also preserved its marker.
- Compaction calls used a five-minute cache segment in the observed summary request while
  ordinary turns used one-hour markers. Preserve per-call TTL and thinking/output differences.
- Compaction is harness behavior, not an automatic consequence of sending a session ID over
  HTTP. A direct transport must relay client-managed compaction, or explicitly own and test
  its own context-management behavior. It must not silently summarize a caller's history.

## Quota hypothesis and memory

The captured `anthropic-ratelimit-unified-5h-*`, `7d-*`, overall status and reset values
reported the same windows for TTY, `-p`, and SDK traffic from this account. Utilization advanced
as calls were made. These successful samples do **not** prove identical enforcement near a
limit, nor support a claim that setting `human` raises a limit. No limit-exhaustion experiment
was performed.

One idle-after-turn TTY process measured `VmRSS=270880 kB`, `VmHWM=282768 kB`, 18 threads.
The synthetic MCP's Bun process measured `22028 kB`. These are one process snapshot, not a
controlled comparison with a deployed direct transport or a guarantee of per-request savings.
Avoiding a Claude subprocess per inference is the proposed memory saving; benchmark it after
implementation under concurrent requests.

## Dynamic billing fields: verified canonical projection

The billing text contains `cc_version=<version>.<three hex chars>`, `cc_entrypoint`, `cch`,
and optional workload, subagent, previous-request, prompt, origin and turn-position fields.
The current binary's readable source constructs a `cch=00000` placeholder; captured requests
contain a changing five-hex-character checksum instead.

Read-only inspection confirmed the current version-suffix function samples positions `4`, `7`,
and `20` of the first non-meta user message, uses `0` for missing positions, and hashes
`59cf53e54c78 + sample + version` with SHA-256, taking the first three hex characters. Which
pre-normalized message reaches that function is important; the final wire message may already
contain added context. Reproduce this against captures before treating it as verified end to end.

An older published whole-body hash hypothesis failed against the current captures. A subsequent
read-only deep dive of [Dario](dario.md) supplied the missing canonical projection. Independently
reimplementing that projection with Bun's built-in xxHash64 reproduced **22/22** captured
`2.1.301` checksums, including TTY, print, tool results, subagents, background notifications and
manual/automatic compaction. The current seed matched Dario's previously calibrated `2.1.177`
seed; that is an observed result, not permission to assume every future version shares it.

Verified procedure:

1. Parse the exact request body. Find the top-level text system block beginning with the billing
   attribution prefix; set only that block's checksum token to `cch=00000`.
2. Set the top-level `model` value to the empty string.
3. Remove top-level `max_tokens`, `fallbacks`, and `fallback_credit_token`.
4. Serialize compactly with JavaScript `JSON.stringify`, preserving property order.
5. Compute xxHash64 of those UTF-8 bytes with seed `0x4d659218e32a3268`.
6. Take the low 20 bits and format as five lowercase hexadecimal characters.

The three-hex version suffix was also reproduced from one original user-text block in every
one of the 17 later private TTY/helper captures checked. Ignoring CLI-injected system-reminder
blocks matters. After compaction, the first user text can be the summary, so the suffix changes.
Do not replace it with a random or merely plausible stable value.

`bin/claude-trace verify-bodies <private-bodies.jsonl>` performs the checksum comparison offline
and returns nonzero on a mismatch or an uncalibrated version. It outputs only version, checksum,
byte counts and match results, never body text. Future versions must be added only after capture
verification. A user message quoting a billing tag must not be rewritten or mistaken for the
actual top-level attribution block.

Dario's current source comments that newer versions omit `cch`; our `2.1.301` captures
contradict that generalization. Its current version table lacks `2.1.301`, so replaying its
uncalibrated-version branch would omit a field this CLI actually sends. Copying that branch
would not reproduce the observed request.

Changing only `cc_turn_origin=human` also mislabels subagent notifications and compaction
calls. Checksum correctness clears one protocol gate; it does not prove identical enforcement,
TLS/header-order parity or safe deployment of a reconstructed transport.

## Next parity checks before fast-mode rollout

1. Keep checksum/suffix calibration tests and rerun them on each new CLI version. Expand the
   parity corpus to non-ASCII inputs, simultaneous clients and multiple selected accounts.
2. Match session/device/account metadata to the selected SDK-authenticated account. Never copy
   another account's metadata or read the host's default credential store for a routed account.
3. Compare normalized TTY/native request classes field by field; identify intentional differences
   explicitly. Do not claim byte-for-byte parity after redacting or reserializing a body.
4. Verify direct streaming/cancellation, native tool round trips, model aliases and context tags,
   quota/cooling/billing classification, and prompt-cache counters through the router.
5. Verify client-managed subagents and compaction without introducing server-side tool execution.
6. Keep SDK login/refresh ownership, single-flight refresh fencing and per-account config-directory
   lifecycle. Do not independently rotate refresh tokens from the inference path.
7. Measure RAM and time to first token with concurrent histories on one and multiple accounts.
8. Keep the router fast flag disabled by default; both infrastructure ConfigMaps now explicitly
   disable it. The live direct tool/cache canary and remaining rollout limits are recorded in
   [fast mode](../idea/claude-fast-mode.md#live-direct-canary-2026-10-16).

## Upgrade and transport checks

Run `bin/claude-trace versions` to compare installed SDK with the npm registry;
`bin/claude-trace update-sdk` updates its dependency/lockfile without silently recalibrating fast
mode. Capture the new CLI version before extending the calibrated version table. Run
`bin/claude-trace transport --model <explicit-model>` for the isolated local TLS/header-order
comparison; it uses fake credentials and a local HTTPS stub, with no provider inference.

With DNS `localhost` and SNI, CLI 2.1.301 and Bun 1.4.2 matched JA3
`1523504b38f0fae0d881d4b6554aac1b`, ALPN `http/1.1`, signature algorithms and header order.
Leave Host, Connection, Accept-Encoding and Content-Length to Bun; explicitly replaying these
framing headers changed their order. This local result does not prove production equivalence.

The same native CLI used a different profile against the local API-key stub: no `cch` or private
origin headers and bare ephemeral cache controls (5m). Real OAuth/canonical-endpoint requests
included checksums, origin diagnostics and 1h TTLs. Endpoint/auth context explains this difference;
do not diagnose a version change from a stub trace alone.
