# Repo settings (manual, not code)

Things that live in GitHub's repo configuration rather than in a workflow file — set once, not
enforced by CI.

- **Private vulnerability reporting**: Settings → Security → "Private vulnerability reporting" →
  Enable. This is what turns the *Report a vulnerability* link in [`SECURITY.md`](../SECURITY.md)
  into a working private advisory form (`/security/advisories/new`); without it the link 404s.
- **Branch protection on `main`**: require the `ci` workflow's `lint` / `typecheck` / `test` jobs to
  pass before merge (see [`workflows/ci.yml`](workflows/ci.yml)).
