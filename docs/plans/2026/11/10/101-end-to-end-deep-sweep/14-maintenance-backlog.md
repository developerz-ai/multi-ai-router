# 14 — Maintenance backlog (dz maintainer, issue / PR / branch hygiene)

> Part of [`overview.md`](overview.md). Depends on: none. Owns: dz/maintainer config in this repo — `.dz/maintainer/maintainer.yml`, `.dz/briefs/{health,improve,release-due,security-release}.md`, `.dz/README.md`, `.agent-pipeline.json`, `.github/dependabot.yml`, `.github/SETTINGS.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/*.yml`, and the issue/label/merge steps of `.claude/commands/feature.md` (:76, :103-120). No scheduled GitHub workflow exists (`ci.yml`, `release.yml` are event-driven; auditor 11 owns them). Repo settings and the dz tool repo (`developerz-ai/developerz.ai`) are named per finding.

Measured 2026-11-10, read-only (`gh` GET + `git ls-remote`). Nothing was closed, labelled, merged or deleted.

## Baseline numbers

| Measure | Value | Command |
|---|---|---|
| Open issues | **6** (4 `ivndev001`, 2 `sebyx07`, 0 bot) | `gh issue list --state open --limit 1000 --json number,title,author,labels,createdAt,updatedAt,assignees,comments` |
| Open PRs | **1** (#368, Dependabot) | `gh pr list --state open --limit 500 --json number,title,author,createdAt,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,statusCheckRollup,closingIssuesReferences` |
| Remote branches besides `main` | **2** (1 Dependabot head, 1 `archive/…`) | `git ls-remote --heads origin` |
| Merged-not-deleted branches | 0 (`delete_branch_on_merge: true`) | `git branch -r --merged origin/main`; `gh api repos/developerz-ai/multi-ai-router --jq '{delete_branch_on_merge,allow_auto_merge,allow_update_branch}'` |
| Closed issues, lifetime | 96 — 94 completed, 2 not planned (2%) | `gh issue list --state closed --limit 1000 --json number,author,createdAt,closedAt,stateReason` |
| Closed PRs, lifetime | 268 — 264 merged, 4 closed unmerged | `gh pr list --state closed --limit 1000 --json number,author,createdAt,closedAt,mergedAt,headRefName,closingIssuesReferences` |
| Issues, last 8 ISO weeks (W39–W46) | 76 opened / 72 closed (W41 22/13, W42 46/36, W43 4/11, W45 1/10, W46 1/1) | group `createdAt` / `closedAt` by `date -u +%G-W%V` |
| PRs, last 8 ISO weeks | 161 opened / 159 merged / 1 closed unmerged (W42 43/44, W45 61/58) | same, on `createdAt` / `mergedAt` |
| Time to merge, merged since 2026-09-15 (n=165) | p50 0.23 h, p90 2.5 h, max 46.6 h; Dependabot p50 3.4 h, dz bot 0.68 h | `jq` over `mergedAt − createdAt` |
| Merged PRs with a closing issue ref (same window) | 45 / 165 (27%) | `closingIssuesReferences` |
| Oldest open item / age buckets | issue #87, 69 d. Issues: <7 d 0 · 7–30 d 4 (#335 at 7 d; #210, #215, #236 at 27 d) · 30–90 d 2 (#138 at 40 d, #87 at 69 d) · >90 d 0 | ledger |
| Open issues with assignee / linked open PR / milestone | 0 / 0 / 0 (no milestone exists) | `gh api 'repos/developerz-ai/multi-ai-router/milestones?state=all'` |
| Tags | 139 `v*`; 21 cut in W45, 41 in W42 | `git ls-remote --tags origin` |
| Actions, last 400 runs (since 2026-10-15) | ci 323 runs (304 ok, 11 failed, 8 cancelled), release 64 (all ok, avg 4.7 min wall), Dependabot 13; none queued, none disabled, none scheduled | `gh run list --limit 400 --json workflowName,event,status,conclusion,createdAt,startedAt,updatedAt,headBranch`; `gh api repos/developerz-ai/multi-ai-router/actions/workflows` |
| Bot comments on the 6 open issues | 21 (`developerz-ai`), 3.5 per issue | `gh issue view <n> --json comments` |

**Reading.** The standing backlog is small and not growing: 6 / 1 / 2. What the owner sees is **throughput and notification volume**, not a pile: 61 PRs and 21 release tags in W45 (28 of the PRs from the dz fleet on 2026-11-02..04, straight after #315 enabled the policy), 46 issues in W42, and several bot comments per issue. The accumulation defects below are real but each currently holds 1–3 items; the mechanisms are what to fix.

**Lifecycle, as configured.**

| Object | Created by | Closed / merged / deleted by | Loop open at |
|---|---|---|---|
| Issue | owners (via `/feature`, `.claude/commands/feature.md:76`); dz checkups (`schedules:` → briefs); platform scout (`broken_only` default) | `Fixes #n` on a merged PR; hand close (`feature.md:120`); stale sweep 30 d (`maintainer.yml:21-22`); inactive sweep 60 d (platform default) | 14.1, 14.4, 14.6, 14.7 |
| PR | owners; dz fleet (`dz/<slug>--<8hex>`, label `dz/fleet-pr`); Dependabot weekly Sun 16:00 | owner squash; dz auto-merge for own + dependency bots (`maintainer.yml:47-49`) after review | 14.2, 14.3 |
| Branch | PR heads; `dz-archive` (fleet teardown) | `delete_branch_on_merge`; dz branch sweep 60 d (platform default, skips `dz/`, PR heads, protected) | 14.8 |

## Findings

### 14.1 medium — Shipped work leaves its issue open: 73% of merged PRs carry no closing reference
- **Kind:** process
- **Where:** `.github/pull_request_template.md:6-9` (no issue field); `.claude/commands/feature.md:76` and `:120` (rule exists, not enforced); dz fleet PR bodies (tool repo)
- **Defect:** Nothing but a `Fixes #n` line closes an issue, and only 45 of 165 merged PRs since 2026-09-15 have one; partial-fix PRs against a list issue never close it.
- **Failure scenario:** #335 shipped in 2.48.0 and 2.50.0 (`CHANGELOG.md:120`, `:156`, both cite `(#335)`; PR #358 `closingIssuesReferences` empty) and is still open 7 d later with a bot "Triage stopped" comment. #138's five items were each shipped by a separate fleet PR (#334, #336, #338, #339, #341 — none references #138) and it is open at 40 d, labelled `needs-repro`.
- **Fix:** (a) add a `## Issue` block to `.github/pull_request_template.md` after line 9: `Fixes #` / `Part of #` / `No issue: <why>`; (b) add row `shipped-still-open` to `.dz/briefs/health.md:12-13`: for each open issue, `git log --oneline origin/main --grep "#<n>"` and `grep -n "#<n>" CHANGELOG.md`; a hit with no open PR is reported under one stable-titled ask listing the numbers — report only, an owner closes; (c) tool repo `developerz-ai/developerz.ai`: fleet PRs dispatched from an issue should emit `Fixes #n` when the task is the whole issue and `Part of #n` otherwise, and the dispatcher should close a list issue when its last child PR merges (edited from that repo).
- **Test:** none in-repo (policy text). Acceptance check: re-run the baseline `closingIssuesReferences` query four weeks after the change; target ≥80% of issue-driven PRs linked.

### 14.2 medium — A green Dependabot PR is parked by a zero-finding "changes requested" review, and the health checkup cannot see it
- **Kind:** maintenance
- **Where:** PR #368; `.dz/briefs/health.md:8` (signal definition); tool repo `packages/review/src/pr-text.ts:129`, `apps/runner/src/modes/worker/review/pipeline/post.ts:597-654`
- **Defect:** The bot's review of #368 is `CHANGES_REQUESTED` with 0 findings because its untrusted-input screen withheld the Dependabot title as "injection"; the bot then refuses to auto-merge until a new review, which only a push or a manual review-trigger comment causes, and `health.md` only flags Dependabot PRs with **failed** checks older than 7 d.
- **Failure scenario:** #368 (docker/login-action 4.6.0→4.7.0, one file) — all 7 CI checks green at 2026-11-08T16:07Z; bot escalation "checks never finished" at 18:15Z (CI had finished 2 h earlier); review at 2026-11-09T00:04Z requests changes with "0 actionable comment(s)". State now: `MERGEABLE`, `BEHIND` (2 behind; `strict: true` on `main`), `reviewDecision: CHANGES_REQUESTED`. Dependabot only pushes on its Sunday slot or a conflict, so the PR waits for a human; Monday's health run reads it as healthy. Every bot comment also resets `updatedAt`, so the 7-day clock in `health.md:8` can never run out on a PR the bot keeps commenting on.
- **Fix:** in-repo: rewrite `health.md:8` to "no Dependabot PR open more than N days since `createdAt`, whatever its checks" (N stated in the brief; propose 7) and add `reviewDecision,mergeStateStatus,createdAt` to the `--json` list. Tool repo (cross-repo, edited there): the title screen must not classify a dependency bot's generated title as injection; a withheld field alone should post `COMMENT`, not `REQUEST_CHANGES`; the babysit escalation should read the check rollup it claims never settled. Repo setting (owner, optional): `allow_update_branch: true` so a behind PR has a one-click exit.
- **Test:** none in-repo. Acceptance: after the brief change, a Monday health firing with #368-like state files one stable-titled ask.

### 14.3 medium — The policy waits for CodeRabbit, which has not reviewed here since 2026-10-15
- **Kind:** maintenance (causal link to the delay `unverified`)
- **Where:** `.dz/maintainer/maintainer.yml:37`, comment at `:53`
- **Defect:** `wait_for_other_bots: [coderabbit]` and the `review.force` comment both assume CodeRabbit is active; it left 108 reviews in total, the last on 2026-10-15, and none on any PR opened since 2026-11-01. No `.coderabbit.yml` exists.
- **Failure scenario:** both Dependabot PRs of 2026-11-08 got their first bot review 8.0 h (#368) and 8.8 h (#369) after opening, against a p50 of 0.15 h for the 45 reviewed PRs since 2026-11-01; #368's review says "Reviewed before CI finished: CI was still running past the wait ceiling" although CI concluded in 2 min. Whether the CodeRabbit wait or a separate settle bug produced the ceiling is not provable from this repo.
- **Fix:** set `wait_for_other_bots: []` at `maintainer.yml:37`; reword `:53` to state the native review is the only reviewer. If the owner intends to re-enable CodeRabbit, keep the line and record that instead — needs a ruling from `sebyx07` or `ivndev001`.
- **Test:** acceptance: next Dependabot PR's first review lands within the p90 (2.2 h) of other PRs.

### 14.4 medium — `hitl` issues are exposed to the stale close; exempted ones have no exit
- **Kind:** process
- **Where:** `.dz/maintainer/maintainer.yml:21-22`; `.claude/commands/feature.md:76`; labels `hitl`, `afk`, `ready` (repo scheme) vs `ready-for-human`, `ready-for-agent`, `needs-repro` (platform scheme)
- **Defect:** The stale sweep (30 d, `comment_then_close`) and the platform's default 60 d inactive sweep exempt only a milestone, a linked open PR, or the `ready-for-agent` / `ready-for-human` labels; the repo's own `hitl` label means nothing to the platform, `ready-for-agent` does not exist as a label, and no milestone exists. Conversely an issue that does carry `ready-for-human` is exempt from every sweep and nothing re-raises it.
- **Failure scenario:** #236 (`hitl`, "decision after two weekly reports"; #234 closed 2026-10-19, four reports have since been delivered) and #210 (`hitl` epic) had their last activity on 2026-11-02 — the bot's own comment — so the sweep comments and closes them from about 2026-12-02 while they wait on a human. #215 (`afk`, blocked on `developerz-ai/claudes#7`, still open) likewise from 2026-12-04. The other direction: #87 (`ready-for-human`, credential rotation unconfirmed) is 69 d old with no assignee, no date and no reminder.
- **Fix:** (a) `feature.md:76`: an issue filed `hitl` or blocked on another repo also gets `ready-for-human`; one filed `afk` and ready gets `ready-for-agent` (label to be created by an owner); (b) new `health.md` row `human-queue-aging`: `gh issue list --state open --label ready-for-human --json number,title,createdAt,updatedAt`; any item older than N days (N in the brief; propose 14) goes into one stable-titled ask "Human queue: decisions waiting" whose body is rewritten each run — one tracking issue, never one per run; (c) owner ruling on whether `stale_action` should be `comment_only` for a repo whose every issue is owner-authored (102 of 102 issues are by `sebyx07`, `ivndev001` or the app).
- **Test:** acceptance: no `hitl` issue is closed by the sweep; the tracking issue lists #87 on the first Monday after the change.

### 14.5 medium — Triage asks owners for a repro on their own chores and epics, then gives up, on every open issue
- **Kind:** maintenance
- **Where:** `.dz/maintainer/maintainer.yml:17-19`; tool repo `apps/agents-manager/src/needs-info.ts`, `apps/worker/src/cron/ask-close-loop-render.ts`
- **Defect:** `ask_for_repro: true` with four required fields and a `qualify_into` that lacks `chore` forces owner-written deferral lists, epics and design notes through the bug intake; `skip_project_members` is unset, so every such issue is re-triaged.
- **Failure scenario:** the generic "needs a little more detail" comment was posted on #87 (2026-10-29, after an owner status update), #138, #215 and #236 (all 2026-11-02, the day the policy landed) — three of them already scoped by the bot weeks earlier; "Triage stopped: could not settle it on its own" on #87, #210, #215 and #335; #87 carries the same "Want to submit a fix?" offer twice within 3 s; #138 was labelled `needs-repro` on a dependency deferral. 21 bot comments across 6 issues, none of which moved an issue.
- **Fix:** add `chore` to `qualify_into` at `maintainer.yml:19`. Owner ruling needed on `skip_project_members: true` (after `:22`): it silences all of the above, but the bot then stops importing owner issues into the fleet backlog unless mentioned — the 28 fleet PRs of 2026-11-02..04 appear to have come through that import (`unverified`). Tool repo: no needs-info round on an issue that already carries the bot's own scoping comment; no repeat of the handoff offer.
- **Test:** acceptance: zero needs-info comments on owner-authored issues in the four weeks after the change.

### 14.6 low — `release-due` files a version-titled ask that nothing closes, in a repo where every PR tags itself
- **Kind:** process (reasoned from the brief; the lane has not fired yet — #354 merged Friday 2026-11-06, first Thursday slot is 2026-11-12)
- **Where:** `.dz/briefs/release-due.md:21-27`; `.dz/briefs/security-release.md:25-26`; `CLAUDE.md` "Leave the trail straight"
- **Defect:** The dedupe key is the exact title **Release `<next>`**, and `<next>` changes whenever a feature PR tags a different version, which happens ~20 times a week; no step closes an ask once a tag at or past it exists, and `release.manager: none` means no automation consumes it.
- **Failure scenario:** `v2.55.0..origin/main` holds only #369 (deps). Thursday's run files "Release 2.55.1"; an owner's next feature PR tags 2.56.0; the ask stays open, and the following run would compute a new title and file again.
- **Fix:** `release-due.md:23`: stable title "Release due", the proposed version in the body; add a step before filing: if an open "Release due" ask names a version ≤ `$last`, report it as satisfied so it is closed. Mirror the title in `security-release.md:25`.
- **Test:** acceptance: at most one open "Release due" issue at any time.

### 14.7 low — Health asks have a file step and no close step
- **Kind:** process
- **Where:** `.dz/briefs/health.md:15-21`
- **Defect:** The brief dedupes by stable title but never says what happens to an open ask whose signal is healthy again.
- **Failure scenario:** `main` goes red, an ask is filed, `main` is fixed by an unrelated PR without `Fixes`; the ask stays open until the 60 d inactive sweep.
- **Fix:** add "## What to close" to `health.md`: for each row that is healthy and has an open issue with its exact title, report it as recovered with the evidence command output, so the ask is closed.
- **Test:** acceptance: recovered asks close within one weekly run.

### 14.8 low — A fleet teardown left an `archive/` branch with no owner and no expiry
- **Kind:** maintenance
- **Where:** `origin/archive/fleet-4/multi-ai-router/runner-state-2026-11-06` (`9e1fa3f`, author `dz-archive`, 2026-11-06); tool repo teardown path (not located: no match for the commit subject under `apps/` or `packages/`)
- **Defect:** The platform documents archives as **tags** (`archive/<branch>/<date>`); this one is a branch, so it shows in the branch list, and the 60 d branch sweep will archive-and-delete it into a second `archive/archive/…` tag.
- **Failure scenario:** 9 commits not on `main`: two quarantine stashes of `dz/pin-the-fast-mode-composition-credential--f2421f0d` (test additions to `claude-fast-response.test.ts`; its PR #326 merged 2026-11-02), a `bun.lock` snapshot, `.codegraph/.gitignore`. File names checked, no credential-shaped path.
- **Fix:** owner decides whether the quarantined test additions are wanted; if not, delete the branch. Tool repo: teardown archives should be tags, with a stated retention.
- **Test:** none.

### 14.9 low — Maintainer docs and labels have drifted from the configuration
- **Kind:** docs
- **Where:** `.dz/README.md:8`; `.github/SETTINGS.md:9-10`; `.agent-pipeline.json`; label set
- **Defect:** (a) `.dz/README.md:8` lists two briefs; four exist. (b) `SETTINGS.md:9` says protection requires `lint`/`typecheck`/`test`; live protection requires `bench`, `build`, `lint`, `test`, `typecheck`, `ui-geometry`, `strict: true`, no required review. It also omits `delete_branch_on_merge: true`, `allow_auto_merge: false`, squash-only. (c) `.agent-pipeline.json` sits at the root; the platform's migration target is `.dz/pipeline/agent-pipeline.json` (tool repo `apps/worker/src/consumers/dz-config-migrate.ts:100`), as wurk has it, and wurk also sets `merge.standingAuthorization`. (d) Labels never used on any issue or PR: `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`; `feature` (1 use) duplicates `enhancement` (42); `claudetm` (23 PRs) is a retired tool's label; `ready-for-agent` is missing (14.4). (e) #335 carries no `area/*`, `size/*` or `afk`/`hitl`; #210 no size; #138 and #87 no `afk`/`hitl`.
- **Failure scenario:** an operator re-creating the repo from `SETTINGS.md` drops three required checks.
- **Fix:** correct (a) and (b) in place; (c) move the file only if the platform has not already scheduled it (owner or tool repo confirms); (d), (e) are label writes for an owner.
- **Test:** none.

### 14.10 low — Both October plan trackers still say `in_progress` five weeks and ~200 PRs later
- **Kind:** docs
- **Where:** `docs/plans/2026/10/02/101-deep-bug-sweep/status.yml:3,7` (46%, 7 slices `in_progress`); `docs/plans/2026/10/02/102-full-router-audit/status.yml:3,7` (80%; 9 slices at `percent: 100` still `in_progress`, e.g. `:19-21`, `:23-25`)
- **Defect:** `current_focus` in both stops at v2.16.0 (2026-10-04); the tree is at v2.55.0; slices at 100% were never marked `complete`, and slices at 0% (`05-web-console.md`, `12-web.md`) have neither been worked nor declared dead. #346 reconciled them once (2026-11-04) and left the statuses.
- **Failure scenario:** the next `/feature` run reads `status.yml` first (`feature.md:16`) and re-surveys findings already fixed, or this sweep's auditors re-report them.
- **Fix:** per slice, set `complete` where `percent: 100`; for the rest, either list the surviving finding ids under `notes` or mark `blocked`/superseded by `2026/11/10/101-end-to-end-deep-sweep`. Cross-checking each remaining finding against code belongs to the slice auditors of this plan, not to this slice.
- **Test:** none.

## Triage ledger

Recommendations only. Ages as of 2026-11-10.

### Open issues (6 of 6)

| # | Title | Author | Age | State evidence | Action | Confidence |
|---|---|---|---|---|---|---|
| 87 | security: rotate and de-commit the literal admin password | owner (`ivndev001`) | 69 d | literal removed in #142 (6a2c7d8); `git grep '"password"' .ui-debugger-mcp.json` empty; rotation on the target not confirmable from the repo; `ready-for-human` | `needs-owner` (confirm rotation, then close) | high |
| 138 | deps: Sentry 11 and Babel 8 held back; price-table follow-ups | owner (`sebyx07`) | 40 d | Sentry `^11.10.0`; Babel 8 for tests + blocker recorded (#339, `CHANGELOG.md:251`); `failure-rules.ts` 57 LOC (#341); `test-now.ts` 280; `last_attempted_at` in schema (#336); price table reconciled (#334) | `close-fixed` | medium (the `claude-opus-4-7-fast` row was not re-read against the vendor page) |
| 210 | epic: Claude Code through the router with one key per person | owner (`ivndev001`) | 27 d | verdict SHIP-THIN recorded 2026-10-19; children #211, #212, #296, #298, #299 closed; #215 open | `keep` (close with #215); add `ready-for-human` | high |
| 215 | docs(clients): recommend the claudes launcher | owner (`ivndev001`) | 27 d | blocked on `developerz-ai/claudes#7` (open); no `claudes` text in `docs/clients.md` or `client-snippets.ts` | `keep`; add `ready-for-human` until unblocked | high |
| 236 | feat(keys): warn-only monthly spend limit per key (deferred) | owner (`ivndev001`) | 27 d | `hitl`; gate "after two weekly reports" met (#234 closed 2026-10-19) | `needs-owner` (build-or-close decision is due) | high |
| 335 | Chat responses carry no per-call cost | owner (`sebyx07`) | 7 d | shipped: `usage.cost` on translated answers (2.48.0, `CHANGELOG.md:156`), `x-router-usage: cost` on passthrough (2.50.0, `:120`, #358) | `close-fixed` | high |

### Open PRs (1 of 1)

| # | Title | Author | Age | State evidence | Action | Confidence |
|---|---|---|---|---|---|---|
| 368 | chore(deps): bump docker/login-action from 4.6.0 to 4.7.0 | Dependabot | 2 d | 7/7 checks green; 2 behind, 1 ahead; `CHANGES_REQUESTED` with 0 findings (14.2); touches `.github/workflows/release.yml` only; no linked issue | `rebase+merge` — an owner updates the branch and either merges or posts the bot's review-trigger comment | high |

No draft, conflicting, failing or superseded PR exists. Closed-unmerged, lifetime: #13 and #75 (bot onboarding, 2026-07/08), #92 (owner), #311 (Dependabot Babel core major, superseded by the Babel 8 work) — none needs action.

### Remote branches other than `main` (2 of 2)

| Branch | Creator | Last commit | State evidence | Action | Confidence |
|---|---|---|---|---|---|
| `dependabot/github_actions/github-actions-minor-and-patch-0c219a018e` | Dependabot | 2026-11-08 | head of open PR #368 | `keep` (deleted on merge) | high |
| `archive/fleet-4/multi-ai-router/runner-state-2026-11-06` | `dz-archive` | 2026-11-06 | 9 commits not on `main`; quarantine stashes of the merged #326 branch; no open PR | `needs-owner`, then `delete-branch` | medium |

Local checkout, list only: `feat/router-error-contract` (#358 merged), `fix/failover-walls-exhausted-exit` (#357 merged), `feat/stream-wall-failover` (#364 merged) — all three upstreams gone; the last is checked out in a second worktree at `/home/superuser/workspace/developerz-ai/mar-stream`, which `CLAUDE.md` § Note says not to use.

Totals: `close-fixed` 2 · `needs-owner` 3 (2 issues, 1 branch) · `keep` 3 (2 issues, 1 branch) · `rebase+merge` 1 · none for `close-duplicate`, `close-stale`, `merge`.

## Checked, not a bug
- `delete_branch_on_merge: true`; zero merged-not-deleted remote branches; zero orphan feature branches.
- Dependabot grouping works as written (`.github/dependabot.yml:14-17`): the 5 PRs of 2026-11-02 were 2 groups + 3 majors, which the file says arrive alone; 4 merged within 3.5 h, 1 superseded.
- `maintainer.yml:40-46` `required_checks` matches live branch protection exactly (6 contexts).
- `auto_merge_scope: own_and_dependency_bots` works: 28 of 30 bot PRs merged, #369 merged by the app after it reverted a Biome bump its own review declined.
- No scheduled GitHub workflow, so no Actions run opens an issue per firing; the dz checkups have filed nothing in this repo so far (the only two app-authored issues, #14 and #76, are onboarding suggestions from July/August, both closed).
- `close_unanswered_repro_after_days: 14` cannot close #138: the platform exempts project members from that clock.
- No duplicate or near-duplicate pair among the 6 open issues.
- Health and improve briefs already use stable titles and a search-before-file rule (`health.md:17-19`, `improve.md:18`).

## Doc claims falsified
- `.dz/README.md:8` says the briefs are `health.md` and `improve.md`; `.dz/briefs/` holds four.
- `.github/SETTINGS.md:9-10` says protection requires `lint` / `typecheck` / `test`; `gh api repos/developerz-ai/multi-ai-router/branches/main/protection` returns six contexts and `strict: true`.
- `.dz/maintainer/maintainer.yml:53` implies CodeRabbit is active; its last review is 2026-10-15.
- `CONTRIBUTING.md:71-74` and `.claude/commands/feature.md:117` say `advisory` is required, a review approval is required and `bench` "never fails CI"; live protection requires `bench`, not `advisory`, and has no required review (auditor 11's files).

## Steps
1. One config PR, no version bump: `maintainer.yml:19` add `chore`; `:37` `wait_for_other_bots: []` and reword `:53` (14.3, 14.5).
2. Same PR: `health.md` — widen the Dependabot signal (14.2), add rows `shipped-still-open` (14.1) and `human-queue-aging` (14.4), add "What to close" (14.7); every window written as a number in the brief.
3. Same PR: `release-due.md:23` and `security-release.md:25` stable title + satisfied check (14.6); `.dz/README.md:8`, `.github/SETTINGS.md:9-10` (14.9); `.github/pull_request_template.md` issue block (14.1); `feature.md:76` label mapping (14.4).
4. Separate docs PR: reconcile the two October `status.yml` files (14.10) once this plan's slice auditors have confirmed which findings survive.
5. Owner queue, routed to `sebyx07` or `ivndev001`, none assumed: apply the ledger (2 `close-fixed`, #368, the archive branch); rule on `skip_project_members` (14.5), `stale_action` (14.4), CodeRabbit (14.3); create label `ready-for-agent`, retire unused labels (14.9); optional `allow_update_branch: true` (14.2).
6. File in `developerz-ai/developerz.ai`, from that repo: injection screen on dependency-bot titles and zero-finding `REQUEST_CHANGES` (14.2), babysit "checks never finished" on a concluded rollup (14.2), needs-info on already-scoped member issues and the duplicated handoff offer (14.5), `Fixes`/`Part of` on fleet PRs (14.1), teardown archives as tags (14.8).

## Tests
- No runtime code changes. Validate `maintainer.yml` against `https://developerz.ai/schemas/maintainer.v1.json` (the platform validator reports on push). `bunx biome check` is not applicable to `.md`/`.yml` here.
- Re-run the Baseline commands four weeks after step 1–3 merge and compare.

## Done when
- Open issues whose fix is in `CHANGELOG.md`: 0. Dependabot PRs open more than 7 d: 0. Remote branches besides `main` and open PR heads: 0.
- Every open `hitl` issue carries `ready-for-human` and appears in one tracking issue once past its window.
- No needs-info comment on an owner-authored issue for four weeks; at most one open "Release due" ask.
- `.dz/README.md`, `SETTINGS.md` and both October `status.yml` files match reality.

## Not covered
- The dz platform's own audit log, task queue and sweep dry-run records: the `developerz` MCP server refused the session's credentials (401), so what the bot planned but did not post is unknown; the stale-sweep dates in 14.4 are computed from the documented rule, not observed.
- Why #368's review waited 8 h (14.3) and why the title screen fired (14.2): read from the bot's own comments; tool code was located, not traced.
- Whether bot comments count as activity for the 30 d stale clock.
- Per-finding survival check of the October plans (14.10).
- `dz-*` sibling checkouts other than `developerz.ai` and `wurk`: branches or copies of the platform repo; not read beyond their README headers.
- Billed Actions minutes: only run-level wall time was measured (ci ≈ 724 min, release ≈ 298 min over 26 days); the repo is public.
