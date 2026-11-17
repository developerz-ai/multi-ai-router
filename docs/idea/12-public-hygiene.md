# Public hygiene

Status: **standing record.** The repository is public: anything a commit once carried stays
readable somewhere until the history itself is cleaned on the server. This file holds the
milestone's history decision and the facts needed to apply it; the item-level records are the
issues (#398, #404, #405). Nothing on this page is closed until the confirmation gate in
section 1 passes — a clean `main` alone closes nothing.

## 1. The history decision (#404)

Repository-history material that must become unreadable is handled by **one server-side purge
request to GitHub Support naming the objects** — never by a rewrite of `main`:

- The material is never only `main`'s branch history. GitHub keeps every pull request's refs
  (`refs/pull/*`) independently of the branches, so a rewrite of `main` that leaves the
  pull-request refs in place makes nothing unreadable: the old commits stay served by the refs
  GitHub itself holds.
- The objects the archive tag left behind when it was deleted from the remote (#398) are kept
  in a bundle off the remote — not reachable by fetch, but still served by SHA until the
  server's purge and garbage collection complete.
- **Until the purge is confirmed** — a fresh clone plus a fetch of the pull-request refs —
  the material is treated as publicly readable. **A clean `main` is not the material being
  gone.**

Applied to the credential below: one purge request covers both halves, the commits the
pull-request refs hold and the objects the deleted archive tag left unreachable. No local
rewrite is performed, because no local rewrite can reach the refs that still serve the
material.

## 2. The credential (#405)

"The historical local-admin password" — the value the audit found, and the only such value in
the repository's whole history (#405). It is never quoted, and never described further, here
or anywhere in this tree.

**How it got in.** A tracked operator-console debug configuration carried the value between
2026-07-31 and 2026-10-02. That file is gone, and no tracked file at `HEAD` carries the value.

**Where it still exists.**

- `main`'s history, in commits inside that window.
- The snapshots the archive tag preserved (#398). The tag was deleted from the remote on
  2026-11-12 and its objects kept in a bundle off the remote, but the objects are still served
  by SHA until the purge. The value there is not tag-only material — it rides the shared
  history, and the pull-request refs serve it like the rest of it.
- Nothing done locally — no rewrite, no filter, no force-push — makes it unreadable before
  the purge. Section 1's single server-side request is the only thing that can.

**The compromise treatment.** The value is treated as compromised. The public repository has
no non-secret, dated record substantiating rotation or no-reuse at every confirmed use site,
so this page does not declare that work complete. Before the history decision can be closed,
the responsible operator must retain a dated, non-secret audit record showing either rotation
or no reuse for each confirmed use site; replacements must never be written into a tracked
file, task record, comment, log, commit, or pull-request body. The throwaway seeded development
database remains outside that record because its own note says its credentials were fake and
throwaway.

**Today's rotation path** — the path any future local-admin password change takes:

- `bin/admin set-password` is the local admin password's only write path
  (`apps/api/src/bin/admin.ts:18`).
- Plaintext never persists: the credential is typed in, hashed with argon2id, and only the
  hash reaches Postgres — "the password itself is nowhere"
  (`apps/api/src/bin/admin.ts:34-36`, `apps/api/src/bin/admin.ts:169`).
- Changing or removing the password deletes every password-login session in the same run
  (`apps/api/src/bin/admin.ts:24-26`).
- Running replicas stop honoring a deleted session within
  `ADMIN_SESSION_REVALIDATE_SECONDS` (`docs/idea/07-security.md:374`).
- The door is off by default and fails closed on a public address
  (`docs/idea/07-security.md:234-243`; `docs/idea/13-admin-oidc.md:6`).
