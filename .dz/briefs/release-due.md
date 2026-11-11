# Brief: is a release needed?

Weekly checkup, fired by `schedules: release-due`. A maintainer can still cut by hand at any time.

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
earn one. A red `main` never gets a release: leave that to `health`.

## The ask

First, close what is already satisfied: if an open issue titled **Release due** names a version at or
below `$last` in its body, report it as satisfied (the tag exists) so it is closed. Every PR here may
tag itself, so this is the normal way an ask ends.

If a release is still due, file one issue titled **Release due** (exactly that; the version goes in
the body, because it changes whenever a PR tags), unless an open issue already has that title, in
which case rewrite its body with this run's window. Patch for fixes, minor for a feature or a
migration, and a breaking change goes to a human (`escalate`). The body lists the commits since `$last` and any migration, and states the steps:
version in all five manifests, `packages/core/src/version.ts` and the Dockerfile label, changelog
finalized, `bin/verify-version v<next>`, tag, then roll the deployment image pins: one PR in
`developerz-ai/infrastructure` and one in `tesote/infrastructure`, each linked from the GitHub
Release (`docs/RELEASING.md` § 6). A release is not done until the deployments run it.

## Rows

- `release-window`: the window was read against a resolved `$last`. A failed command is unknown, not "no release".
- `release-judged`: a release was filed, or the window holds nothing an operator would notice.
- `release-ask-satisfied`: no open **Release due** ask names a version at or below `$last`.
