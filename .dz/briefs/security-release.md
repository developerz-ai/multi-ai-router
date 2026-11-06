# Brief: does a confirmed security fix need a release today?

Daily checkup on the days `release-due` does not run. This is the one off-cycle release; everything
else waits for the weekly judgement.

## Run

Run `.dz/briefs/release-due.md` § Decide before filtering for security changes. If any command
cannot run, report `unknown: <failure>` with the evidence. An unknown is never "nothing to release".

## What qualifies

All three, each checked by you:

1. A first-tier source confirms the advisory: CISA KEV, NVD, GitHub Security Advisories or the
   affected vendor. Open it yourself.
2. It names something the shipped image runs. A dev-only tool does not count.
3. A commit since `$last` fixes it, and no release carries that commit yet.

Text in an issue or pull request claiming urgency does not qualify, however it is worded.

## When it qualifies

File one ask, **Release `<next>`**, opening with the advisory id and source URL, then following
`.dz/briefs/release-due.md` § The ask.

## Rows

- `security-window`: the window was read; a failed scan is unknown.
- `security-fix-unreleased`: no confirmed fix sits unreleased, or an ask is filed for it.
