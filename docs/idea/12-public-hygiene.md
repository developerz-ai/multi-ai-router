# Public hygiene — the historical local admin credential

Status: record only. This page records a decision about history. It does not rotate a credential,
purge a ref, rewrite a branch or change any running site.

The credential this page discusses is the historical local admin console password, stored in the
development seed as the stable placeholder `HISTORICAL_LOCAL_ADMIN_PASSWORD`. The placeholder is
the only spelling used here: no value, replacement secret, personal email address or legal name is
part of the record.

## Why this replaces the prior attempt

PR [#420](https://github.com/developerz-ai/multi-ai-router/pull/420) tried to land this record in
`docs/idea/12-public-hygiene.md` together with a CHANGELOG entry. It was closed unmerged on
2026-11-22. The review and close evidence says why:

- The PR's own `address_comments` reply (2026-11-15) recorded that the runs behind
  [issue #404](https://github.com/developerz-ai/multi-ai-router/issues/404) ended `needs a human`
  and then `evidence_blocked`, so no decision was recorded there. The draft nevertheless wrote a
  decision into the spec and CHANGELOG.
- Owner `ivndev001` closed the PR on 2026-11-22 stating that #404's history decision was still
  open, that [issue #405](https://github.com/developerz-ai/multi-ai-router/issues/405) carried no
  per-site rotation record, and that a documentation PR could be re-cut from those two items
  once recorded. Green CI on the PR head (`44870706078`) did not clear that review.
- The log of `run_4bef328a60cf41d9ad3170afe7fb9d39` is **unavailable to this attempt**. That id is a
  developerz.ai platform run, not a GitHub Actions run: the Actions run lookup returned
  `not_found`, a GitHub issue search for the id returned no results, and the platform dashboard
  path requires sign-in. The run's own explanation of the failure therefore cannot be quoted here,
  and nothing below claims what it said.

This attempt differs in three ways. It records only what the current PR and issue evidence
supports. It names the unavailable run explanation as unavailable instead of inferring a decision
from it. It adds no rotation, purge or rewrite step, and does not claim one was done here.

## The issue #404 decision, applied to this credential

Issue #404 asked for the pull-request-refs decision to be recorded and verified. Its actual
disposition is the opposite of a recorded decision: three attempts ended without a merged change,
and the issue was closed `not_planned` on 2026-11-21 with the last comment asking for a narrower ask
or more detail before a reopen. Its comments (6819119020, 6843105635 and 7063493809) record an
error, a duplicate attempt that itself ended `failed`, and the close. No owner ruling selected a
purge mechanism, and none is claimed here.

The principle that <em>was</em> established in the attempts is the one that matters for this
record: pull-request refs hold their own reachable copies of a commit. Removing or rewriting a
commit on `main` does not remove the same bytes from `refs/pull/*`. Applying that principle
consistently to `HISTORICAL_LOCAL_ADMIN_PASSWORD`, a rewrite of `main` that leaves the pull-request
refs in place **does not make the value unreadable**. This is the same reason a main-only history
rewrite was not performed.

## Where the value still exists, and what would make it unreadable

- In `main`'s commit history between 2026-07-31 and 2026-10-02, where the tracked file that held
  it was carried by those commits. No tracked file at HEAD carries the value; the file was fixed.
- In archive-tag snapshots created from that history, which hold their own copies of the blobs.
- In pull-request refs created from those commits, for the reason above.

The value becomes unreadable through history only when every reachable copy is made unavailable,
including the pull-request refs, the archive tags and any forks that took them, or when the
credential's meaning is changed so an old value no longer authenticates anything. Changing the
credential's meaning is what the completed change leg did. A main-only rewrite retaining
pull-request refs cannot claim that result, so none is claimed here.

## Compromise and completed change

The credential was treated as compromised. The evidence is the completed audit leg of this goal,
which located the commits and every use site without reproducing the value, and the completed
change leg, which changed the confirmed sites outside the throwaway seeded development database
and recorded them on issue #405 with the date. The audit found the throwaway seed use confined to
that database and left it alone; no surviving local admin console instance was found still
authenticating with the historical value. Those operations are cited as done, not repeated here:
no credential was regenerated, no instance was reconfigured, no ref was purged and no history was
rewritten in producing this record.

Related: [00-overview.md](00-overview.md), [07-security.md](07-security.md).
