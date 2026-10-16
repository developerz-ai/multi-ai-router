# Dario deep dive: what the router can verify and reuse

Read-only checkout: `tmp/dario`, cloned 2026-10-16 at
[`4b7482aef0912ae95305bb0e1e6db8f4dded3c8e`](https://github.com/askalf/dario/tree/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e),
package version `6.13.16`. MIT licensed. No Dario server, install script, authentication flow,
or provider probe was executed. Conclusions below distinguish its implementation from behavior
independently measured in [our Claude captures](claude-wire.md).

## Architecture and request construction

Dario's Claude path is direct HTTP with credential management and a captured Claude Code
template. `live-fingerprint.ts` captures the installed CLI's system/tool/envelope shape,
static headers, header order and beta set. `cc-template.ts` constructs outbound requests;
`proxy.ts` coordinates translation, account selection, request rewriting, transport and retry.
The latter is large; transplanting it would import unrelated policies into this router.

It has two materially different paths:

- Native-client/passthrough requests retain more of the caller's body and identity headers.
- Template replay constructs a new envelope for other clients, then serializes and stamps it.

The distinction matters. A header-looking payload is insufficient: identity text, field order,
metadata, tools, beta flags, cache breakpoints, thinking and output configuration all participate.
A captured template is evidence of one version/account/configuration, not a universal request.
Its live shape cache recognizes multiple observed system-prompt variants, avoiding a drift alarm
when a provider switches between known variants.

Source:
[live-fingerprint.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/live-fingerprint.ts),
[cc-template.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/cc-template.ts),
[proxy.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/proxy.ts).

## Checksum breakthrough, independently verified

`src/cch.ts` describes a canonical projection before xxHash64: zero the billing checksum,
blank `model`, remove `max_tokens`, `fallbacks`, and `fallback_credit_token`, then compactly
serialize. Its historical calibrated seed reproduced **22/22 current `2.1.301` captures**
when used with that projection. The previous whole-body formula reproduced none.

The router diagnostic independently implements this small algorithm using Bun's built-in
xxHash64; it does not import or execute Dario's implementation. The calibrated version table
accepts only the current independently checked version. Unknown versions fail verification.

Dario's production table lists only `2.1.177`. Its comments and uncalibrated-version branch
assume recent clients omit `cch`. Our current captures contradict that assumption: they carry
nonzero checksums and the canonical projection reproduces them. Copying its current emission
policy would therefore lose fidelity for `2.1.301`.

Source:
[cch.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/cch.ts),
[cch-calibrate.mjs](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/scripts/cch-calibrate.mjs).

## Billing attribution is more than a checksum

Dario's version-suffix helper deliberately uses a stable approximation based on its loaded
template. That differs from the current CLI's first-user-text sampling. Our read-only inspection
and private-body comparison reproduced the real suffix from one original user block in all
17 later TTY/helper bodies checked. Injected system-reminder blocks must be skipped, and a
compacted summary can become the first user text.

Its synthesized billing entrypoint is `sdk-cli`; that is not keyboard TTY's `cli`. Current TTY
captures also carry prompt/turn positions and conditional origin/linkage fields. Child calls
and compact helpers do not use the same attribution as a fresh human turn. Reusing Dario's
builder verbatim would not implement the requested keyboard profile.

This is why `human` cannot be a global string replacement. A real keyboard interaction can
produce a human turn, subagent requests, a summary helper and task-notification continuations.
Our captured background completion uses `task_notification`, not `human`.

## Cache controls and tools

Dario's cache code evolved across several client versions. The current implementation can
mirror a caller's explicit one-hour/five-minute TTL with its enabling beta, otherwise uses a
default. It explicitly places rolling conversation breakpoints and removes old ones. Its own
comments contain historical observations that differ; the live capture is the tie-breaker.
Our current main requests used one-hour stamps, while summary calls introduced five-minute
segments. A blanket TTL rewrite would lose that distinction.

It avoids spending an extra breakpoint on the tools array when later system breakpoints
already cover that prefix. Our initial unvalidated draft proposed an extra tool breakpoint;
that draft was moved back into `tmp` before integration. Breakpoint placement needs a test
against the native profile, not just a test that the API accepts some cache marker.

Dario also supports tool-name/schema transformation and platform-aware tool catalogs. Those
choices are not automatically this router's contract: caller-declared tools execute at the
client. Copying the host CLI's full built-in catalog into every proxied request would advertise
capabilities the router must never execute and alter prompt/cache costs.

Source:
[cc-template.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/cc-template.ts),
[tool-schema-contract.mjs](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/test/tool-schema-contract.mjs).

## Account identity and credential ownership

Dario assembles device/account/session metadata and correlates the outbound session header with
the body. Its identity reader searches home-directory files and backups. That is suitable only
for its own configured credential authority; copying that fallback into this multi-account
router would risk selecting host identity for another account.

Our router must read only the selected account's isolated config directory, under its existing
ownership/deletion fence. Keep the SDK as the only login/refresh-token writer. Dario's separate
OAuth and distributed refresh-lock implementations are research inputs, not a reason to add
another refresh-token consumer beside the SDK. A refresh race can invalidate an entire account.

Dario's separate `subagent.ts` installs a diagnostic assistant into Claude Code. It is not the
implementation of native inference subagents. Its existence does not establish that parent and
child Messages histories are safely separated in a replacement transport. Our TTY experiment
provides that evidence: metadata session IDs can be shared while histories differ.

Source:
[accounts.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/accounts.ts),
[oauth.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/oauth.ts),
[subagent.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/subagent.ts).

## Transport, streaming and limits

Dario distinguishes the process runtime/TLS shape, HTTP header order and HTTP/2 behavior
from JSON/header values. It prefers Bun and exposes a stricter runtime check. Being on Bun
is useful evidence, but our MITM captures cannot prove production TLS ClientHello parity:
the provider sees the proxy's TLS handshake during a trace. Our separate local HTTPS
comparison subsequently matched CLI/Bun ClientHello fingerprints and header order (see the
wire record), but that still does not establish production enforcement equivalence.

Its streaming code distinguishes errors before a response starts from errors after bytes have
been sent, and supports cancellation versus optional draining. This router must retain its own
rule: fail over only before client-visible bytes; promptly cancel a disconnected caller's
upstream. Do not import a replay-after-stream-start policy or an unconditional drain.

Its pacing/rotation/model-override features are independent behavior changes. Random delays,
rotating IDs or substituting another model are not established by our successful traces as
necessary for fidelity. They also conflict with several existing router contracts. None were
adopted as a shortcut to a claim of account safety.

The failure classifier usefully separates billing, temporary limits and rejected credentials.
The router already has richer per-account health/quota handling; use its existing boundaries
and regression tests rather than importing a parallel state machine.

Source:
[runtime-fingerprint.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/runtime-fingerprint.ts),
[outbound-proxy.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/outbound-proxy.ts),
[midstream.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/midstream.ts),
[upstream-rejection.ts](https://github.com/askalf/dario/blob/4b7482aef0912ae95305bb0e1e6db8f4dded3c8e/src/upstream-rejection.ts).

## Reusable research workflow

The strongest reusable idea is a captured, versioned profile plus offline drift checks.
A loopback collector with a stub API key can capture serialization without inference or real
authentication. It cannot by itself prove subscription-specific betas, TTLs or quota behavior;
compare that profile with a small, authorized real-account MITM sample.

Keep version/build provenance, profile variants, checksum calibration, safe summaries and
private exact bodies separate. Run native TTY, `-p`, SDK, multi-turn, tools, concurrent
subagents and compaction after upgrades. Use actual request/counter evidence to distinguish
working behavior from an old code comment. `bin/claude-trace` provides that workflow in this
repository; Dario's drift/calibration scripts informed the additional offline verification.
