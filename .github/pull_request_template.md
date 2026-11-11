<!--
Keep the PR small enough to review in one pass. If it mixes an unrelated
refactor with the actual change, split it.
-->

## What & why

<!-- The diff shows what changed. Explain why — what problem this solves,
     or what it enables. -->

## Issue

<!-- One line. `Fixes #` closes the issue on merge; use it only when this PR is the whole fix.
     A list issue or an epic takes `Part of #`, and is closed by hand when its last part merges. -->

- Fixes #
- Part of #
- No issue: <why>

## Behavior change?

- [ ] This PR changes observable behavior (new endpoint, new config, new
      failure mode, changed routing/translation/quota logic, ...)
- [ ] `docs/idea/` is updated in this same PR to match
- [ ] N/A — docs-only, tests-only, or internal refactor with no behavior change

## Non-negotiables checklist

<!-- Delete lines that don't apply. See CLAUDE.md for the full list. -->

- [ ] Claude subscriptions: login and refresh stay with the SDK / CLI; the fast
      transport reads only the selected Account's token under its ownership
      fence; nothing reads another Account's or HOME credentials or patches
      the CLI
- [ ] Agent SDK tool execution still passthrough-only, explicit allowlist,
      `settingSources: []` — nothing runs on the router host
- [ ] No upstream credential appears in a response, log, or error
- [ ] Client-requested model is never substituted, downgraded, or re-routed
- [ ] Key scope stays an intersection (pool members ∩ key scope) — never widened
- [ ] `cooling_down` (429 + `Retry-After`) and `exhausted` (402) still kept distinct
- [ ] No blocking I/O (Postgres query, usage insert) added to the request-critical path
- [ ] No new hardcoded retention window / TTL / interval — added as config
- [ ] No same-dialect body re-parsed/re-serialized; no stream buffered before forwarding

## Tests

- [ ] `bin/check` passes locally (lint + typecheck + full test suite)
- [ ] New unit tests are pure (no mocks/clock/network)
- [ ] New integration tests boot a real server against **mocked** upstreams
      — no real provider, real OAuth, or live `claude` CLI subprocess
- [ ] `apps/api/test/integration/claude-sdk-security.test.ts` still passes,
      untouched (security regression gate — never skip or relax)

## How to verify

<!-- Commands or steps a reviewer can run to see this working. -->
