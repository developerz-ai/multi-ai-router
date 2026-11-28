# Brief: improvement

Fired on the first and third Monday of each month by `schedules: improve` (`weeks_of_month: [1, 3]`).

Twice a month, leave multi-ai-router measurably better. `CLAUDE.md` binds every change, and `non_goals` in the
policy file are off limits. A red `main` and a stuck Dependabot PR belong to the platform's red-main ask.

## Pick at most three, in this order

1. Anything the gate on fresh `main` found broken or flaky (`bin/check`): the root cause, never a retry or a skip.
2. Open bugs (`gh issue list --state open --label bug --json number,title,url`), each starting from a test that fails on `main`.
3. `CLAUDE.md` and README claims that no longer match the code, then dead code.

## Ship

One small PR per improvement, its evidence in the body, `bin/check` green first. Never bump the version or touch release automation here.
Check no open PR or issue already covers it. If nothing is worth changing, do nothing: no empty PRs, no churn.

## Rows

- `gate-regressions`: Anything the gate on fresh `main` found broken or flaky (`bin/check`): the root cause, never a retry or a skip.
- `open-bugs`: Open bugs (`gh issue list --state open --label bug --json number,title,url`), each starting from a test that fails on `main`.
- `claims-and-dead-code`: `CLAUDE.md` and README claims that no longer match the code, then dead code.
