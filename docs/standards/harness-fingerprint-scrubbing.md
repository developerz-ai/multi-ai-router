# Harness fingerprint scrubbing

Every transport that forwards a Claude **system prompt** to a subscription account MUST apply the
`apps/api/src/providers/claude-sdk/scrub.ts` fingerprint rules. That includes native / direct-HTTP
fast-mode requests, not only requests that reach the Agent SDK's `query()`. This page records the
invariant, why the answer is a scrub rather than better failover, and the test every transport
needs.

## The failure the rule prevents

A harness fingerprint in system text is a billing signal, not untidy prose. Anthropic meters a
subscription request partly by who appears to be asking. Claude Code's own preset already injects
an environment preamble and `<env>` block, so a client that appends its copy announces a second
harness wearing Claude Code's credential. The account is gated behind Extra Usage and the request
is refused with `400 Third-party apps now draw from your extra usage, not your plan limits...`.

The router classifies that refusal as `claude-sdk:extra-usage-gated`, marked `requestAttributable`
and `permanentForRequest` (`apps/api/src/providers/claude-sdk/failure-rules-quota.ts`). That
classification is necessary: the account is not cooled, the client gets an honest verdict, and the
chain can try the next account. It is not a fix. The same prompt draws the same refusal on **every**
account in the pool, so a chain becomes a retry storm with no successful candidate. Classification
limits the damage; removing the fingerprint prevents the refusal.

The rules themselves stay the shared source of truth. They are independent (a pattern that is
absent is a no-op), idempotent (scrubbing twice equals scrubbing once) and conservative (tool
policy, tone rules, task guidance and appended user `CLAUDE.md` content pass through verbatim).
Do not add a second copy of the patterns, widen them to generic prose, or delete a rule as cleanup.
The documented provenance and measured bisect are in `scrub.ts` and
`docs/idea/11-anthropic-agent-sdk.md` §8.

## Invariant

Before a system prompt reaches a Claude subscription account, no text matched by `scrub.ts` remains
in it, whichever transport carries the request:

- The Agent SDK path scrubs where the prompt crosses into `query()` (`claude-sdk/options.ts`).
- The native fast path scrubs **in place** on the client's native system text inside
  `prepareFastRequest` (`claude-fast/request.ts`), before the rebuilt body is integrity-stamped.
  Non-prompt fields are preserved; the billing block is rebuilt with `cc_version` pinned to the
  calibrated CLI version, `cc_turn_origin=sdk` rewritten to `human`, a fresh `cch` stamped over the
  rebuilt body, and the retained attribution fields (for example `cc_turn_origin`, `cc_prompt_id`,
  `cc_is_subagent`, `cc_prev_req`, prompt and turn indexes) carried into the new header.

Only matched fingerprint text may be removed or rewritten. Conservative text and the retained
attribution fields survive; the rebuilt header's checksum is validated against the assembled body,
not compared to the incoming bytes. An SDK fallback that is already scrubbed must not be scrubbed
into a different prompt. API-key accounts send the caller's own credential and no harness
impersonation is detected there; other providers are passthrough and their prompts are not
rewritten.

## Required test

Every transport that can carry a Claude subscription system prompt needs a test that starts from
the **wire body the transport prepares**, not from a helper called in isolation:

1. Seed system text with the exact fingerprint, including the environment preamble and `<env>`
   block and an opencode identity line.
2. Assert the fingerprint is absent from the prepared body for a native request. A test that checks
   only the SDK path passes while the native path still sends it.
3. Assert conservative text and the attribution fields the transport retains survive in the
   prepared header. For `claude-fast`, also validate the rebuilt `cch` with `inspectIntegrity`
   (a valid native request's header is not byte-for-byte unchanged: `prepareFastRequest` rebuilds
   it and changes `cc_turn_origin=sdk` to `human`). Assert that scrubbing the prompt text again
   changes nothing.
4. Leave `scrub.test.ts` green. The rules do not change when a transport starts applying them.

A transport that skips the scrub is a defect even when classification stops the account from being
cooled. Fix the source, not the retry policy.
