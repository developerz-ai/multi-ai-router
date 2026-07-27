# Contributing

Multi AI Router is a self-hosted proxy: your tools speak the OpenAI or
Anthropic wire protocol to it, and it fans requests out across a pool of
provider accounts and API keys you configure. Contributions should keep that
single job sharp — see `CLAUDE.md` for the non-negotiables (many-accounts-
per-provider is the normal case, upstream credentials never leave the router,
the client picks the model and the router picks the account, and so on).
Read it before your first PR; it overrides any convention you'd otherwise
guess at.

## Getting started

```
bin/setup   # fresh clone → prereqs, install, .env, dev Postgres, migrate
bin/dev     # each session: API + web, watch mode
bin/check   # before every commit: lint + typecheck + full test suite
```

Those three commands are the house contract. If a task is worth running
twice, it belongs in `bin/`, not a one-off shell invocation copy-pasted into
a PR description.

Other commands you'll use often:

| Task | Command |
|---|---|
| Single test by pattern | `bun test <pattern>` |
| Lint only | `bin/lint` |
| Format | `bin/fmt` |
| Dev DB shell / migrate / reset | `bin/db psql` · `bin/db migrate` · `bin/db reset` |
| Overhead budget (p50/p95/p99 + TTFT) | `bin/bench` |

## Workflow

- One PR per change. Keep it small enough to review in one pass; a PR that
  mixes an unrelated refactor with the actual fix gets sent back.
- **A behavior change updates `docs/idea/` in the same PR.** The spec under
  `docs/idea/` is the source of truth for what the router does — a shipped
  feature the docs don't describe, or a doc describing something unshipped,
  is a bug either way.
- Match existing patterns before introducing a new one. Check
  `docs/reusable-code.md` before writing a helper — the second real
  implementation earns an abstraction, not the first.
- Files stay ≤300 LOC, split by responsibility. Thin routes, fat services;
  repositories own all SQL.
- Run `bin/check` before every commit. It refuses to run without a
  `DATABASE_URL`, so it can never pass locally on fewer tests than CI runs.
  The refusal is enforced from inside the run — `bun test` reads `.env.test`
  and ignores `.env.local`, the reverse of every other `bun` invocation, so a
  shell-side check would police a value the suites never see. If the gate says
  you have no database and `.env` says otherwise, `bin/lib/database-url` prints
  the one the run actually uses.
- New unit tests are pure — no mocks, no clock, no network; inject the
  snapshot. New integration tests boot a real server over real HTTP against
  **mocked** upstreams — never a real provider, real OAuth, a live `claude`
  CLI subprocess, or a real credential in a fixture.
- `apps/api/test/integration/claude-sdk-security.test.ts` is a security
  regression gate. Never skip, quarantine, or relax it.

## Commit and PR expectations

- Conventional-ish prefixes (`feat:`, `fix:`, `test:`, `docs:`, `ci:`,
  `perf:`, `dx:`) matching this repo's existing history — `git log
  --oneline` is the style guide.
- PR description explains *why*, not just *what* — the diff already shows
  what changed.
- CI (lint, typecheck, test) must be green before merge. `bin/check` runs
  the same gate locally in the same order, so there should be no surprises.

## Non-negotiables

The full list — Claude subscriptions through the Agent SDK only, tool
execution never on the router host, credentials never leaving the router,
`cooling_down` vs `exhausted`, pure routing/translation/quota functions, the
<5ms overhead budget, and more — lives in `CLAUDE.md` at the repo root.
Read it. It is not optional context; it is enforced in review.

## Reporting a bug or requesting a feature

Use the issue templates — `.github/ISSUE_TEMPLATE/bug_report.yml` or
`feature_request.yml`. For a security issue, do not open a public issue; see
`SECURITY.md`.
