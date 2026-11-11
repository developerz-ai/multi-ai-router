# Brief: is the project healthy?

Weekly (Monday) checkup fired by `schedules: health`: the failures no issue or PR announces.

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha,url`, then `git rev-parse origin/main` | `success` on the `origin/main` tip; a null conclusion or another sha is no verdict |
| Dependabot is not stuck | `gh pr list --app dependabot --state open --limit 100 --json number,title,createdAt,reviewDecision,mergeStateStatus,statusCheckRollup` | no Dependabot PR open more than **7 days since `createdAt`**, whatever its checks, review or merge state. `createdAt`, not `updatedAt`: every bot comment moves `updatedAt`, so a PR the bot keeps commenting on would never age |
| Shipped work is closed | for each `gh issue list --state open --limit 200 --json number,title`: `git log --oneline origin/main --grep "#<n>\b"` and `grep -nE "#<n>\b" CHANGELOG.md`, then `gh pr list --state open --search "<n>" --json number` | no open issue with a hit on `main` or in `CHANGELOG.md` and no open PR naming it |
| The human queue is moving | `gh issue list --state open --label ready-for-human --limit 200 --json number,title,createdAt,updatedAt` and the same for `--label hitl` | no issue with either label open more than **14 days since `createdAt`** |

## Rows

- `main-green`: `main` is green (the existing main CI check).
- `dependabot-not-stuck`: no Dependabot PR open more than 7 days, whatever its checks.
- `shipped-still-open`: no open issue whose fix is already on `main`.
- `human-queue-aging`: no `ready-for-human` or `hitl` issue waiting more than 14 days.

## What to file

For each unhealthy signal, one ask, unless an open issue already carries its exact title
(`gh issue list --state open --search "<title> in:title" --json number,title`, then compare byte for byte).
Titles are stable: nothing that changes run to run (sha, run URL, issue numbers) goes in one; that goes in
the body, with the command and its output. Unreadable evidence is no verdict: re-run it, never file it as a
defect. A red `main` comes first.

The titles: `main is red`, `Dependabot PR stuck`, `Shipped work still open`, `Human queue: decisions waiting`.

`shipped-still-open` and `human-queue-aging` **report only**: the ask lists the issue numbers with the
evidence, and an owner closes or decides. Never close, relabel or comment on the listed issues. When the
ask is already open, rewrite its body with this run's list instead of filing again: one tracking issue,
never one per run.

## What to close

For each row that is healthy this run and has an open ask with its exact title, report it as recovered
with this run's command output as evidence, so the ask is closed. An ask whose signal is healthy again
never waits for the inactive sweep.
