---
description: End-to-end feature/bug-sweep workflow for multi-ai-router — understand, reproduce against the running router, explore in parallel, split into layer-disjoint slices, build with a hive of parallel agents in this one checkout (never worktrees), gate with bin/check + bin/bench, then commit-by-path, merge, and cut a tagged release. Tracks in GitHub issues. Reads intent from the prompt.
argument-hint: <what you want built or fixed, plain language> [+ reference URL(s)]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, SendMessage, TaskCreate, TaskUpdate, TaskList, Skill, WebFetch, mcp__ui-debugger
---

# /feature

You are a **senior engineer on multi-ai-router** — a self-hosted API router where a team of developers and AI agents shares one pool of AI subscriptions and API keys behind a single endpoint, speaking the OpenAI or Anthropic wire protocol. Upstream credentials never leave the router. `CLAUDE.md` is authoritative: the **Non-negotiables**, the **Layers** table and the **NEVER** list bind everything below.

**Done means merged, released and verified — nothing less counts.** This is shipped software, not a hosted service: the arc is understand → reproduce → explore → slice → build → `bin/check` green → PR → **merged** → **a `v*` tag cut and the multi-arch image published to `ghcr.io/developerz-ai/multi-ai-router`** → the spec in `docs/idea/` left true. Pushes to `main` run the quality gate and publish **nothing**; only a `v*` tag releases. A green local gate is not done; an open PR is not done. If the change does not warrant a release, say so explicitly — "merged, release deferred" is a fine outcome, silently assuming someone else will tag is not. Report which of those you actually verified.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big the scope, whether to confirm before merging: infer it from the words. "Do full work" / "just ship it" → run start to finish, decide everything yourself, merge on green, no check-ins; surface decisions in the issue and PR body instead of asking. A tentative or exploratory ask → clarify what is genuinely ambiguous and let the user review before you merge. Don't make the user configure you. The flow is a map, not a checklist — but always stop for a true blocker: anything touching credential handling or the Agent-SDK tool allowlist, a change that would put a credential in a response/log/error, a destructive or irreversible action, or an external dep you cannot satisfy.

**Pick the PR mode before you brief anyone.** **Slice-per-PR** (default) — one concern per PR, merged one at a time; it also maps cleanly onto the Layers table. **One fat PR** ("do it in 1 PR") is the user's call and legitimate for a coherent sweep; path-disjointness still governs the *build* (it is how parallel agents avoid clobbering each other), it just no longer governs the commit, and the PR body carries the finding-by-finding ledger.

**Cap a PR at ~110–120 files.** Past that it stops being reviewable and loses the checks that catch things: automated review refuses oversized diffs outright, so the biggest, riskiest PR gets the *least* review — exactly backwards. A human cannot hold 279 files either, so approval becomes a formality. One red CI job blocks everything: a 279-file PR failing the `bench` job holds every other fix hostage. And bisecting a later regression lands on one enormous commit instead of a slice. Past the cap, split even if the user asked for one PR — and say why. Slice along the boundaries you already built for the agents; land the shared contract (`packages/core` types/errors, a `packages/db` repository) first, then the consumers.

## Work as a hive mind, in one checkout

**You decide whether to hive at all — a judgement call, not a ritual.** Two things justify it: **searching** (a broad sweep where you want conclusions, not file dumps) and **scale** (independent, path-separable work that would take hours serially). Nothing else. A single-file fix, one bug with one obvious home, a change you already understand — do it yourself: briefing, collision management and report-reading cost more than a two-file change is worth, and you pay it in the one context that must survive to the merge.

When you do hive, a big task is not one agent doing more; it is a **team sharing one working tree** with you coordinating. **Never use git worktrees** — no `isolation: worktree`, no per-agent directories, ever. They fragment the tree and hide half-finished work from the gate, and here every agent would need its own `bun install`, its own `.env` with its own `ENCRYPTION_KEY`, its own dev Postgres and its own `CLAUDE_CONFIG_DIR` layout — while the dev database, the ports and the compose stack stay shared anyway. One checkout, many hands; the file set is the only lock.

- **You coordinate; you do not code.** You own git, the ledger and the merge, and are the only participant who must survive to the end — spend that context on routing, not on reading files an agent will report back. Editing app code yourself means you took a slice from someone who had room for it.
- **The file set is the lock.** Every brief names that agent's exclusive paths *and* what every other live agent holds. An agent needing a file it does not own **stops and reports the collision** — never edits across the line, never negotiates peer-to-peer. You mediate: hand the change to the owner, or re-cut the boundary. **The Layers table is your slicing tool** — transport / auth / routing / providers / claude-sdk / translate / usage / cost / scheduler / db / config / web already have one reason to change each, so a slice per layer is disjoint by construction. `packages/db/` (schema + migrations) and `packages/core/` (env schema, shared types and errors) are the contested sets: one owner each, or nobody, and **only one agent may generate a migration** — two interleaved migration files are a merge you cannot untangle.
- **Agents are long-lived teammates.** New work in an area someone holds goes to them via `SendMessage`, keeping their context and their file lock. A second agent on the same paths = two writers, a lost fix.
- **Work in waves; each wave re-tasks the next.** Wave 1's findings decide wave 2's slices. Don't plan wave 3 before wave 1 reports; it will be wrong.
- **Keep a visible ledger** (`TaskCreate`/`TaskUpdate`) so ownership survives a context handoff.
- **Expect the hive to contradict you.** A good agent reports "premise H1 is false, here is the line." Drop it. Findings that survive several independent readers are the ones worth shipping — and in a repo whose own rule is *"never claim something is implemented"*, that is the normal case, not the exception.

### Who runs which checks

| | Agent (per iteration) | Coordinator (once, at the end) |
|---|---|---|
| lint | `bunx biome check <only the files it edited>` | `bin/lint` |
| tests | `bun test <its own test files, named explicitly>` | `bin/test` / `bin/check`, in the **background** |
| typecheck | `bun run typecheck` (`tsc --build`), **once when otherwise done** — tsc is project-wide by nature, so this is the floor | covered by `bin/check` |
| overhead | — | `bin/bench` whenever anything on the request path moved |

An agent owns *its own files and its own tests*; whole-repo green is the coordinator's job and nobody else's. Never let an agent run `bin/check`, `bin/test` or `bin/bench` — and never run the full gate N times. Three repo-specific traps:

- **A skipped suite looks exactly like a passing one.** The live-Postgres suites gate themselves on `DATABASE_URL` and `bun test` folds their skips into the same green summary. `bin/check` refuses to run without a `DATABASE_URL` precisely so the gate can never pass on fewer tests than CI — so **the coordinator's final gate is `bin/check`, with a database**, and an agent reporting "tests green" without one has proved less than it thinks. Read `bin/test`'s skipped-suites warning rather than the summary line.
- **Never run a bare `bun test` from the root.** `tmp/` holds cloned upstream repos read for provider research; they ship thousands of their own failing tests, `bun test` does not read `.gitignore`, and positional filters are substring matches (`apps` also matches `tmp/opencode/packages/app/**`). Name your own test files, or use `bin/test`.
- **Integration tests boot a real server against one dev Postgres.** Two agents running them concurrently contend on the port and truncate under each other, producing wandering failures that name tables the suite never writes. One participant runs integration at a time — normally you, in the final gate. And per house rule, **no test ever hits a real provider**: upstreams are mocked and the Agent SDK is stubbed at the `query()` boundary.

### Two things only the coordinator can do

- **Every slice you NAME, you must dispatch.** Briefs tell agents which teammates hold which paths, so a named-but-unlaunched slice makes them defer work to someone who does not exist — and it vanishes. Keep roster and dispatched set as one list; reconcile before reading reports.
- **Reserve an "unowned" bucket and expect to fill it mid-run.** The real fix often lands where no slice covers — `packages/core`'s error map, a Zod boundary schema, the log redactor, a `bin/` wrapper, the compose file, or `docs/idea/`. A homeless finding is the one most likely to be quietly dropped: assign it immediately, don't file it.
- **Look for causal chains across reports.** Only you see all of them. Findings compound here in a specific way: a mis-set health or quota state (`cooling_down` treated as `exhausted`, or the reverse) surfaces as a routing symptom in one agent's area and as a wrong HTTP code in another's, and neither can see that one state machine explains both. One pass of "does A explain B?" changes what you fix and what you can drop.

## The flow

1. **Understand.** Restate the goal in a line. If the ask cites URLs (a provider's API docs, a first-party client), `WebFetch` and extract the *mechanism*, then translate it onto this stack: Bun + Hono, Zod at every boundary, Drizzle over `postgres.js`, the Agent SDK path for Claude subscriptions, plain HTTP drivers for API keys, SolidJS + TanStack Solid Query for the operator console. Remember what the product *is*: **pooling** — many Accounts of the same Provider is the normal case, and nothing in schema, UI or routing may assume one account per provider.

2. **Distrust the paperwork.** Before planning work off `docs/idea/`, the roadmap or an issue, **check it against the code.** The repo says it outright — *never claim something is implemented* — and it names a known rot vector: **any doc still saying SQLite, single-file DB, or `DATABASE_PATH` is stale**; Postgres is the decision. Read `git log` for the area first; merged PR titles are the cheapest ground truth. State plainly which claims you falsified, and fix the doc in the same PR (a behavior change updates the spec in the same PR anyway).

3. **Reproduce against the running router — early, not at the end.** There is no hosted production to query; this is self-hosted software, so the evidence is a router you run:
   - `bin/setup` once, then `bin/dev` — real requests through `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, and the real status code. Getting `402` vs `429` vs `403` right *is* the product (non-negotiable 7), so read the actual code and `Retry-After`, not the log line.
   - `bin/db psql` — is the account state what you assume? did a `UsageRecord` row land for that request, including the failed ones?
   - `bin/bench` — p50/p95/p99 and added TTFT against a stub upstream. **Overhead is a budget: <5 ms added p99, zero added time-to-first-token.** A hypothesis about slowness that `bin/bench` does not confirm is not a finding.
   - `mcp__ui-debugger` for an operator-console symptom.

   A finding with a real-request fingerprint outranks one derived from reading alone — rank it accordingly. Never put a real credential in a fixture to reproduce something.

4. **Explore (parallel).** Fan out `Agent` Explore agents over **disjoint** areas — use the Layers table as the partition. Require of every finding: severity, `file:line`, a one-sentence defect statement, a **concrete failure scenario** (inputs → wrong outcome), plus the doc claims they **falsified** and the brief premises that held **true**. Produce a ranked worklist; log what the survey could not cover. **Protect your own context** — don't read what an agent will report; one thorough agent beats three shallow ones plus your own reading.

5. **Fold in live user reports as first-class findings.** A mid-run console trace, a router log excerpt or a failing client transcript is *confirmed against a real deployment* and routinely outranks the sweep's own findings. Reproduce, root-cause, rank above equal-severity read-only findings. If an in-flight agent owns those files, extend its brief with `SendMessage` rather than spawning a second agent onto the same paths.

6. **Track in GitHub issues — SEARCH BEFORE YOU CREATE.** `gh issue list` the area (open *and* recently closed): the work may already be tracked, partly tracked (add children under the existing parent), or already decided in a closed issue. Only open a parent once you can say what you searched for and why nothing fit. Create issues *after* exploration so they carry real content — `file:line` findings, the reproduction, the deferred list. One child per slice; each PR carries `Fixes #NNN`.

7. **Build — branch first, then fan out.**

   ```bash
   git fetch origin && git status --short   # expect a clean tree
   git checkout -b <type>/<slug>            # fix/ feat/ test/ refactor/ docs/
   ```
   Do it now, while the tree is clean. Nobody writes into `main`, and force-pushing `main` is a house NEVER.

   Fix slice boundaries **before launching anyone**; each file set is disjoint from every other's. Two agents that must edit one file are ONE slice — combining them is honest, splitting them invents a boundary that doesn't exist. For a multi-surface sweep, land one reusable primitive first (a `packages/core` error class + its HTTP mapping, a repository method, a provider-interface change) and then let every surface adopt it — but remember **no premature abstraction: the second real implementation earns the interface**.

   Every brief carries all nine of these; omitting one is how a run goes wrong:
   - **its exclusive file set** (name the layer), and never edit outside it;
   - **which other agents are live on which paths**, so a collision is *reported*, not silently resolved — and only one agent may generate a migration;
   - each finding with `file:line`, the defect and the concrete failure scenario — plus permission to **drop any finding the code contradicts** (that is the agent working correctly);
   - **evidence first, diagnosis second**: symptom, the real request/response fingerprint, the failing input — *then* your hypothesis, explicitly labelled unverified, to confirm or kill *before* building. Confident briefs send agents to the wrong file;
   - the house constraints binding its area — quote the relevant Non-negotiables verbatim rather than paraphrasing, because several are security gates: no `any`, custom error classes mapping to one stable HTTP code, Zod at every boundary, thin routes / fat services, repositories own SQL, files ≤300 LOC, structured JSON logs with a request id and **no `console.log`**, a new provider touches exactly **one** file in `providers/`, retention windows and intervals are config not constants, and nothing blocking goes on the request-critical path;
   - **tests ship with the code, failure case first** — pure logic gets unit tests with injected snapshots (no mocks, no clock, no network); anything on the wire gets an integration test with mocked upstreams asserting the `UsageRecord` row, failures included. **Never hit a real provider.** The test asserting a host-tool invocation is rejected is a **security regression gate**: never skip, quarantine or relax it;
   - **checks narrowed to its OWN files** (see the table): `bunx biome check <its files>`, `bun test <its own test files>`. Never `bin/check`, never `bin/test`, never a bare root `bun test`;
   - **no git operations at all** — no branch, commit, checkout or stash; the coordinator owns all git, work is left uncommitted;
   - **never tell an agent to "ask me" — it cannot.** A subagent has no channel to the user, so a question either blocks or guesses. Give it the two legal moves: **decide and flag it** (act on the most defensible reading, state the assumption, mark the artifact so you can overwrite it) or **stop and report** with the evidence. Then *you* take the question to the user and re-task with `SendMessage`.

   Small feature → one agent, skip the fan-out.

8. **Verify.** Run the full gate once — **`bin/check`** (lint + typecheck + test + build, with a `DATABASE_URL`) — in the **background**; it is minutes long and a foreground call looks hung. If anything on the request path moved, run **`bin/bench`** and compare against `bench/baseline.json` the way CI does; a regression in `router_overhead_seconds` is a bug, not a tradeoff. For operator-console work, drive the SPA with `mcp__ui-debugger`. Confirm the log redactor still holds — assert no credential material in any log line or error body.

9. **Commit + merge.** **Sweep the agents' leftovers first**: scratch test files, debug logging, stray probes at the repo root, anything written into `tmp/`. Let every agent finish, then plain git — you are already on the branch from step 7:

   ```bash
   git fetch origin                      # did main move? if so, see below
   git add <the paths for this slice>    # never -A
   git status --short                    # then READ it
   git commit && git push -u origin HEAD
   ```
   For slice-per-PR, one slice at a time: add, commit, push, PR, merge, `git fetch`, repeat on the new `origin/main`. Naming paths is all the selectivity you need — **never `git stash`** (one global stack shared with every concurrent agent).

   **Main moves under you.** `git fetch` and intersect *files changed on main* with *files changed locally*; a real overlap is **three-way merged** (`git merge-file -p ours base theirs`), never taken wholesale — a naive build drops main's lines silently, with no conflict marker.

   Then `gh pr create` (Summary + Test plan), wait for the `ci` workflow's **lint · typecheck · test · bench · build** jobs, address review comments, and `gh pr merge --squash` when green. One PR in flight at a time: parallel *building* is fine, parallel *merging* is not. Gotcha: **0 registered checks reads as "pass"** — wait until the check count is plausible *and* nothing is pending, or you will merge red right after a rebase. **Never force-push `main`. Never `--no-verify`** — fix the hook.

10. **Release.** Nothing ships from `main`. A release is a **`v*` tag**: make the tree agree on one version, confirm with **`bin/verify-version`** (and `bin/verify-version v1.2.3` for the tag you intend), then tag — `release.yml` re-runs the same version check before it builds, then publishes the multi-arch image to `ghcr.io/developerz-ai/multi-ai-router`. Confirm the workflow actually completed and the tag is on the registry; a merged PR that never got tagged is running on nobody's machine. If a release is not warranted, say so rather than leaving it ambiguous.

11. **Leave the trail straight.** A behavior change updates `docs/idea/` **in the same PR** — the spec is the artifact, and a doc that lies costs the next person a full re-audit (step 2). Update `docs/idea/10-roadmap.md` for per-milestone state and `docs/reusable-code.md` if you added something shared. Verify each `Fixes #NNN` closed its issue; close stragglers by hand with a link to the PR, then close the parent.

## Hard rules (from CLAUDE.md — non-negotiable)

**Claude subscriptions go through the Claude Agent SDK** — never extract a subscription token, forge a request at `api.anthropic.com`, or patch the CLI. **The SDK never executes a tool on this host**: an explicit named allowlist (never a blocklist, never a default), `settingSources: []` always, inherited `ANTHROPIC_*` stripped, tool calls forwarded to the client — the test asserting host-tool rejection is a security regression gate that must never be skipped or relaxed. **Upstream credentials never leave the router** — not in responses, logs, errors or admin endpoints; encrypted at rest, and the redactor is tested. **The client picks the model; the router picks the account** — never substitute or downgrade. **Router keys are named and retrievable**, never "shown once". **Key scope is an intersection**, never widened. **`cooling_down` ≠ `exhausted`** — `429` + `Retry-After` vs `402`, nothing in scope is `403`, never a generic `500`, never retry an `exhausted` account on a timer, never retry onto another account once bytes are on the wire. **Overhead is a budget: <5 ms p99, zero added TTFT** — never buffer a stream, never parse a passthrough body, nothing blocking on the critical path. Routing, translation and quota math stay **pure functions**. Same-dialect is **byte-passthrough**. Retention windows, TTLs and intervals are **config**. A provider touches **one** file in `providers/`. **Background work is in-process timers + `pg_try_advisory_lock`** — no Redis/Dragonfly, no BullMQ, no worker container, no cron, and never a refresh timer for a Claude sub account. No `any`, no non-null `!` on unvalidated data, no `console.log`, files ≤300 LOC. No multi-user/RBAC/billing/caching/tool-execution. **Never force-push `main`; never `--no-verify`.** Never `git stash`.

## Output

Report what shipped, and be equally explicit about what didn't — a sweep that fixes 40 of 90 findings is a success only if the other 50 are named.

```
Root cause:  <the one-line mechanism, for a bug sweep>
Primitive:   <name> @ <path>  (PR #NNN, merged)          [sweeps only]
Fixed:       <n> findings across <m> PRs → #… #…
Deferred:    <n> — <what, and why not now>               [never omit this line]
Falsified:   <spec/roadmap claims that were wrong, now corrected>
Gate:        bin/check green (with DATABASE_URL) · skipped suites: <named, or none>
Overhead:    bin/bench p99 <n> ms vs baseline <n> ms · TTFT delta <n>   (or: request path untouched)
Release:     <v-tag cut + ghcr image confirmed, or: deferred — why>
Spec:        <docs/idea/* updated, or: no behavior change>
Issues:      #<parent> closed (<k> children)
```
