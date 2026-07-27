# Releasing

Multi AI Router ships as a multi-arch container image
(`ghcr.io/developerz-ai/multi-ai-router`), built and published only when a
`v*` tag is pushed. Pushes to `main` run the CI quality gate and publish
nothing — a release is a deliberate, separate act.

## 1. Bump versions

`packages/core/src/version.ts` holds the `VERSION` constant — the string
surfaced at `/healthz`, in the `router_build_info` metric, the boot log, the
admin settings endpoint, and the console footer. Every workspace
`package.json` restates it, and all of them must move together:

- `packages/core/src/version.ts` — **the source**
- `package.json` (root)
- `apps/api/package.json`
- `apps/web/package.json`
- `packages/core/package.json`
- `packages/db/package.json`

Bump every one to the same semver, then prove it:

```sh
bin/verify-version          # the tree agrees with itself
bin/verify-version v1.0.0   # …and the tag you are about to push names it
```

`bin/check` catches a mismatch too (a drift test in `packages/core` walks the
workspace globs), and `release.yml` runs `bin/verify-version` against the tag
before it builds a single layer — so a tag that does not name the version the
code reports fails the release instead of publishing an image that lies about
what it is.

## 2. Update the changelog

Add a new section to `CHANGELOG.md` under `## [X.Y.Z] — YYYY-MM-DD`, above
the previous release. Follow [Keep a Changelog](https://keepachangelog.com/):
group entries under `Added` / `Changed` / `Fixed` / `Documentation` as
applicable. Pull the entries from the merged PRs since the last tag —
`git log --oneline <last-tag>..HEAD` and `gh pr list --state merged` are
the sources of truth, not memory.

Add the new version's link reference at the bottom of the file
(`[X.Y.Z]: https://github.com/developerz-ai/multi-ai-router/releases/tag/vX.Y.Z`).

## 3. Verify the gate is green

```sh
bin/check   # lint + typecheck + full test suite, same order as CI
bin/bench   # confirm the overhead budget hasn't regressed (non-blocking in CI, but check it here)
```

Commit the version bump and changelog as their own PR, merge it to `main`
through the normal review flow — no direct pushes to `main`, no skipped
review for a release commit.

## 4. Tag and push

Once the version-bump PR is merged and `main` is green:

```sh
git checkout main
git pull
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

Use an annotated tag (`-a`), matching semver, prefixed with `v`. A tag
containing a hyphen (`v1.0.0-rc.1`) is treated as a pre-release: the image
build still runs, but the `latest` tag is suppressed and the GitHub Release
is marked pre-release.

## 5. What `release.yml` does from here

Pushing the tag triggers `.github/workflows/release.yml`, unattended:

1. **build** — native per-arch image build (`linux/amd64`, `linux/arm64`),
   each pushed to `ghcr.io` by digest.
2. **merge** — the two digests are combined into one multi-arch manifest
   list, tagged `X.Y.Z`, `X.Y`, and `latest` (the `latest` tag is skipped for
   pre-releases).
3. **github_release** — a GitHub Release is created against the tag, with
   auto-generated notes from the merged PRs since the previous tag, plus the
   `docker pull` line for the image.

Nothing here is manual or ad hoc — if a step needs to change, it changes in
`release.yml`, not in a one-off command run by hand.

## 6. After the tag

- Confirm the release is visible: https://github.com/developerz-ai/multi-ai-router/releases
- Confirm the image pulls:
  `docker pull ghcr.io/developerz-ai/multi-ai-router:X.Y.Z`
- Confirm `docker compose up -d` against the freshly tagged image boots
  clean (migrations run at boot, healthcheck gates the router) — this is the
  same path a new operator takes from `README.md`.

## Pre-releases

For a release candidate, bump the version to `X.Y.Z-rc.N` — the constant and
every manifest, exactly as in step 1 — and tag `vX.Y.Z-rc.N`. The pipeline
runs identically, publishes the versioned image tag, and creates a GitHub
pre-release, but never touches `latest` — safe to cut without affecting
anyone pulling the default tag.

The rc carries its pre-release suffix in `VERSION` on purpose: an rc whose
`/healthz` says `1.3.0` is indistinguishable from the release it precedes, and
that is precisely the build an operator most needs to identify. `bin/verify-version`
enforces the match, so an rc tag on a tree bumped to plain `1.3.0` fails.

### Promoting an `-rc` to stable

An `-rc` is not re-tagged into a release — it is superseded by a clean tag:

1. If the code changed at all since the last `-rc` (even a one-line fix),
   go through steps 1–4 above again against the new state — an `-rc` earns
   its stable tag by being identical to what was validated, not by renaming.
2. If nothing changed, tag the exact same commit the last `-rc` pointed at
   with the plain `vX.Y.Z` (no hyphen). The build runs again from source —
   there is no promote-in-place step in `release.yml` that copies a
   pre-release's image forward — but the digest will match if the inputs
   didn't change.
3. `latest` and the GitHub Release's "Latest" flag only ever land on a
   hyphen-free tag, so this is the step where the release actually becomes
   the one `docker compose pull` picks up by default.
4. Leave the superseded `-rc` tag(s) and their GitHub pre-releases in place
   — don't delete them. They're the record of what was validated along the
   way.

## Rollback

A bad tag is not un-published — `docker pull` will always find it again — but
`latest` and any environment that tracks it move back:

1. **Stop pointing `latest` at the bad version.** Never force-move an
   already-pushed tag (`git tag -f`) to make `latest` point somewhere else —
   a tag that's been pulled is immutable here, full stop. Instead, cut a new
   tag (`vX.Y.(Z+1)`) from the last-known-good commit — or from a revert
   commit if the bad change already merged further work on top — and push it
   normally. `latest` moves forward onto that tag the same way it always
   does. A rollback is a forward release, not a rewind.
2. **Pin deployments to the explicit last-good version** while the fix lands:
   `image: ghcr.io/developerz-ai/multi-ai-router:X.Y.(Z-1)` in
   `docker-compose.yml`, not `:latest` — every operator following
   [`docs/idea/09-deployment.md`](docs/idea/09-deployment.md) is already
   pinning a version tag for exactly this reason.
3. **Do not roll back a database migration to un-release a version.**
   Migrations run at boot and are additive/idempotent by convention; a
   version bump is not expected to require a schema rollback. If a migration
   itself is the defect, that's a `fix:` PR with its own new migration, not a
   reverted one — see the migrations convention in `CLAUDE.md`.
4. **Note the incident in the new release's `CHANGELOG.md` entry** — what
   broke, who's affected, what changed. A silent respin erodes the version
   number's meaning as a promise about what's inside.
