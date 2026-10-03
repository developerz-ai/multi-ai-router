---
description: Write a concise, self-contained execution plan (feature or bug sweep) to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another AI to implement
argument-hint: [what you want done — a feature, or "find bugs in <area|everything>"]
allowed-tools: Write, Read, Glob, Grep, Agent, Bash
---

# /planx

Produce a concise plan another AI can execute with zero extra context. **Plan only** — no implementation, no edits outside the plan dir. The executor is typically [`/feature`](feature.md), which takes the plan dir as its request.

`CLAUDE.md` is authoritative: the **Non-negotiables**, the **Layers** table and the **NEVER** list bind every plan. A plan that proposes breaking one is wrong, not bold.

## Goal
$ARGUMENTS

**Two modes, read from the goal:**
- **Feature** — "add X", "support Y". Slices = areas of work.
- **Bug sweep** — "find bugs", "audit", "deep dive". Slices = the Layers table (one file per layer). The plan *is* the bug ledger: every finding documented with `file:line`, defect, concrete failure scenario, fix, test. Nothing is fixed while planning.

## Steps

1. **Resolve path.** `date +%Y`, `date +%m`, `date +%d`. Dir = `docs/plans/<YYYY>/<MM>/<DD>/`. `Glob docs/plans/<YYYY>/<MM>/<DD>/1*` → next number = highest existing `1NN-*` + 1, else `101`. Slug = kebab-case title, ≤5 words. Plan dir: `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`.

2. **Distrust the paperwork.** `git log --oneline -30` for the area; `gh issue list --state all --search <area>` — the work may already be tracked or decided. `docs/idea/` is the spec but *never claim something is implemented*: check claims against code. Any doc still saying SQLite / `DATABASE_PATH` is stale — note it as a finding.

3. **Explore.** Spawn `Agent`s over **disjoint** areas, partitioned by the Layers table. Feature mode: one `Explore` agent (very thorough) is usually enough — ask for patterns + files to touch (`file:line`), tests (unit vs integration), `packages/core` types/errors, `packages/db` repositories/migrations, gotchas. Bug-sweep mode: one `general-purpose` agent per layer group (≤8), **read-only on code**, each writing **its own slice file directly into the plan dir** (disjoint paths — the file set is the lock) and returning only a short summary, so your context survives. Never `isolation: worktree`.

   Every bug-sweep brief requires, per finding: severity (`critical|high|medium|low`), `file:line`, one-sentence defect, **concrete failure scenario** (inputs/state → wrong outcome), suggested fix, the test that proves it (failure case first). Rank non-negotiable violations (credential leak, host-tool execution, model substitution, scope widening, `cooling_down`/`exhausted` conflation, buffered stream, Postgres on the critical path) above everything else. Also require: doc claims **falsified**, and what the agent **could not cover**. Speculation is labelled `unverified`; a finding the code contradicts is dropped, not softened.

4. **Cross-check.** Only you see every slice. Look for causal chains (one mis-set health/quota state surfacing as a routing symptom in one slice and a wrong HTTP code in another), duplicates across slices, and findings that contradict each other. Fold them into `overview.md`; dedupe by keeping the finding in the slice that owns the fix's file.

5. **Write the plan as multiple files** — never one big `plan.md`. `overview.md` index + one `<NN>-<aspect>.md` per slice. House style of `docs/idea/`: terse fragments, `file:line` refs, tables.

   **`overview.md`**:

```markdown
# <Title>

## Goal
1-2 sentences: what + why.

## Context
- Only the stack facts the executor needs (Bun + TS strict, Hono, Zod, Drizzle over postgres.js, Agent SDK for Claude subs, SolidJS + TanStack Solid Query).
- Reference patterns: `apps/api/src/<area>/<thing>.ts:12` — follow this for Z.

## Plan files (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line. Owns: `<paths>`.

## Ranked worklist            ← bug sweep only
| # | Sev | Slice | `file:line` | Defect |

## Causal chains / cross-slice   ← bug sweep only

## Done when
- Verifiable acceptance criteria. Always includes `bin/check` green with `DATABASE_URL`; `bin/bench` if the request path moved.

## Risks / open questions
## Not covered
```

   **Each `<NN>-<aspect>.md`**:

```markdown
# <NN> — <Aspect>

> Part of [`overview.md`](overview.md). Depends on: <NN-prior or "none">. Owns: `<exclusive paths>`.

## Files to change          ← feature mode
- `path:line` — what changes, why.

## Findings                 ← bug-sweep mode, ranked
### <NN>.<n> <sev> — <title>
- **Where:** `path:line`
- **Defect:** one sentence.
- **Failure scenario:** inputs/state → wrong outcome.
- **Fix:** concrete steps; reference `file:line`, don't paste code.
- **Test:** unit (pure, injected snapshot) or integration (mocked upstream, asserts `UsageRecord`).

## Steps
1. Ordered, concrete actions.

## Tests
- Tests ship with the code, failure case first. `bun test <its own test files>`; `bunx biome check <changed files>`; `bun run typecheck` once at the end. Never a bare root `bun test` (`tmp/` holds upstream repos), never `bin/check` per slice — that is the coordinator's, once.

## Done when
- Verifiable acceptance criteria for this slice.
```

6. **Write `status.yml`** next to `overview.md` — the one tracker. New plans start `not_started` / `0%`. `created_by` + `owner` = `git config user.name`. `worked_by` empty; the executor fills it.

```yaml
plan: <1NN>-<slug>
title: <title from overview.md>
status: not_started        # not_started | in_progress | blocked | complete | superseded
created_by: <git config user.name>
worked_by: ""
owner: <git config user.name>
percent: 0
current_focus: ""          # ONE line: next slice to pick up
slices:
  - file: 01-<aspect>.md
    status: not_started    # not_started | in_progress | complete
    percent: 0
    findings: 0            # bug sweep only
evidence: []               # PRs / commits, e.g. ["#141", "abc1234"]
notes: ""
last_updated: <YYYY-MM-DD>
```

## Rules
- Compact English. Fragments. `file:line` and `symbol` refs over prose. Tables for structured data.
- Reference-only: point at code, don't paste it.
- No checkboxes in `.md` slices — `status.yml` is the only tracker.
- Self-contained: executor reads `overview.md`, its slice, and the files those cite.
- Slices are **path-disjoint** so `/feature` can hive them in one checkout. `packages/db` (schema + migrations) and `packages/core` are contested — one slice owns each; only one slice may add a migration.
- Respect `CLAUDE.md`: Agent SDK for Claude subs, named tool allowlist + `settingSources: []`, credentials never leave the router, client picks model, scope is an intersection, `cooling_down` ≠ `exhausted` (429 / 402 / 403, never a generic 500), <5 ms p99 + zero added TTFT, pure routing/translation/quota, byte-passthrough same-dialect, config not constants, one provider = one file, in-process timers + advisory locks (no broker), no `any`, no `console.log`, files ≤300 LOC, no test hits a real provider.
- Behavior change → the plan names the `docs/idea/` file to update in the same PR.
- `bin/` is the interface — plans cite wrappers, never raw invocations.

## Output
```
✓ docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
  + 01-<aspect>.md, 02-<aspect>.md, …
  + status.yml
Findings: <n> (critical <a> · high <b> · medium <c> · low <d>)   [bug sweep]
Next: /feature docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
```
