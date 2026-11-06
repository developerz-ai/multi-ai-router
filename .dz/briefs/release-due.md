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

If a release is due, file one issue, **Release `<next>`**, unless an open issue already has that exact
title. Patch for fixes, minor for a feature or a migration, and a breaking change goes to a human
(`escalate`). The body lists the commits since `$last` and any migration, and states the steps:
version in all five manifests, `packages/core/src/version.ts` and the Dockerfile label, changelog
finalized, `bin/verify-version v<next>`, tag.

## Rows

- `release-window`: the window was read against a resolved `$last`. A failed command is unknown, not "no release".
- `release-judged`: a release was filed, or the window holds nothing an operator would notice.
