# Repo settings (manual, not code)

Things that live in GitHub's repo configuration rather than in a workflow file — set once, not
enforced by CI.

- **Private vulnerability reporting**: Settings → Security → "Private vulnerability reporting" →
  Enable. This is what turns the *Report a vulnerability* link in [`SECURITY.md`](../SECURITY.md)
  into a working private advisory form (`/security/advisories/new`); without it the link 404s.
- **Branch protection on `main`** (as set on 2026-11-10, `gh api repos/developerz-ai/multi-ai-router/branches/main/protection`):
  - required status checks, **strict** (the branch must be up to date with `main`): `bench`,
    `build`, `image`, `lint`, `test`, `typecheck`, `ui-geometry`, the `ci` workflow's jobs of those names (`image` required once that job is on `main`)
    (see [`workflows/ci.yml`](workflows/ci.yml)). `advisory` runs on every PR but is not
    required. `bench` is required even though the job is `continue-on-error: true`, so a red
    `bench` check can still hold a merge until it is re-run green;
  - no required review approvals, no required signatures, no linear history; force-pushes and
    deletion of `main` are refused; the rules are not enforced for admins (`enforce_admins: false`);
  - Keep `.dz/maintainer/maintainer.yml` `pr.required_checks` equal to this list.
- **Tag ruleset `v*`**: a repository ruleset on tags matching `v*` blocks update and deletion, so a
  published `vX.Y.Z` can never be moved to another commit or removed. `release.yml`'s `gate` job
  (`bin/release-gate`) is the other half: it refuses a tag not on `main`, or one whose commit main's
  CI has not passed.
- **Merge settings**: squash merge only (merge commits and rebase merges off),
  `delete_branch_on_merge: true`, `allow_auto_merge: false`, `allow_update_branch: false`.
