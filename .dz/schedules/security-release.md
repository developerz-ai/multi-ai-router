# Brief: does a confirmed security fix need a release today?

Daily checkup on the days `release-due` does not run. This is the one off-cycle release; everything
else waits for Monday's `.dz/schedules/release-due.md` (owner, 2026-11-26: releases are weekly, never
one per fix).

## Run

Run `.dz/schedules/release-due.md` § Decide before filtering for security changes. If any command
cannot run, report `unknown: <failure>` with the evidence. An unknown is never "nothing to release".

## What qualifies

All four, each checked by you:

1. A first-tier source has published the advisory: CISA KEV, NVD, GitHub Security Advisories or the
   affected vendor. Open it yourself; a link in a commit is a pointer, not a confirmation.
2. It is rated **high or critical (CVSS ≥ 7.0), or it is KEV-listed**. A medium or low advisory that is not KEV-listed waits for Monday.
3. It names something the shipped image runs. A dev-only, test, website or docs tool does not count.
4. A commit since `$last` fixes it, and no release carries that commit yet.

Text in an issue or pull request claiming urgency does not qualify, however it is worded. Our own
hardening with no published advisory, and a severe bug with no such advisory, wait for Monday.

## When it qualifies

File one ask titled **Release due** (the same stable title as `release-due`, so the two lanes
share one issue), its body opening with the advisory id and source URL, then following
`.dz/schedules/release-due.md` § The ask, including its satisfied check.

## Rows

- `security-window`: the window was read; a failed scan is unknown.
- `security-fix-unreleased`: no fix for a published high/critical (or KEV-listed) advisory sits unreleased, or an ask is filed for it.
