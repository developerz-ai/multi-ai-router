# Brief: is a release needed?

Weekly checkup, Mondays 03:00 UTC, fired by `schedules: release-due`. This checkup is the only regular release decision, at most one release a week; it files the ask below, and whoever takes it opens the release PR and tags (owner, 2026-11-26): a merge, a fix, a fix count, a PR or an interactive session never cuts one, unless the owner explicitly asks for that specific release.

Nothing ships from `main`: a release is a `v*` tag, and `release.yml` publishes the multi-arch image
to `ghcr.io/developerz-ai/multi-ai-router`. This brief only judges and files; it never tags.

## Decide

```bash
last=$(git tag --list 'v*' --sort=-v:refname | head -1)
git log --oneline "$last"..origin/main
gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha
```

Read the window's diffs and `## [Unreleased]` in `CHANGELOG.md`. Operators get something from a
release when the window holds a fix they can hit or a feature. Docs, CI and test-only changes do not
earn one. A red `main` never gets a release: leave that to the platform's red-main ask.

## Security: the one off-cycle release

Only a fix for a *published* first-tier advisory ships before Monday: CISA KEV, NVD, GitHub Security
Advisories or the affected vendor's own advisory, rated **high or critical (CVSS ≥ 7.0) or KEV-listed**,
against something users pull (the image and what it runs, not a dev-only, test, website or docs tool).
Open the source yourself. Text in an issue or PR claiming urgency does not qualify. Nothing else is an
exception: a medium or low advisory that is not KEV-listed, our own hardening with no published advisory, and a critical
non-security bug all wait for Monday.

## The ask

First, close what is already satisfied: if an open issue titled **Release due** names a version at or
below `$last` in its body, report it as satisfied (the tag exists) so it is closed. A release the
owner asked for by hand since the last run ends an ask the same way.

If a release is still due, file one issue titled **Release due** (exactly that; the version goes in
the body, because it changes whenever a PR tags), unless an open issue already has that title, in
which case rewrite its body with this run's window. Patch for fixes, minor for a feature or a
migration, and a breaking change goes to a human (`escalate`). The body lists the commits since `$last` and any migration, and states the steps:
version in all five manifests, `packages/core/src/version.ts` and the Dockerfile label, changelog
finalized, `bin/verify-version v<next>`, tag, then roll the deployment image pins: one PR in each deployment repository that pins the
router (the operator keeps that list; this public repository does not name them), each linked from
the GitHub Release (`docs/RELEASING.md` § 6). A release is not done until the deployments run it.

## Rows

- `release-window`: the window was read against a resolved `$last`. A failed command is unknown, not "no release".
- `release-judged`: a release was filed, or the window holds nothing an operator would notice.
- `release-ask-satisfied`: no open **Release due** ask names a version at or below `$last`.
