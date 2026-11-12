# Plans

Execution plans written by `/planx` for another AI (usually `/feature`) to implement. Plan only — no code.

The tree currently holds no plan documents. The internal sweep/audit plans
(`2026/10/02/101-deep-bug-sweep`, `2026/10/02/102-full-router-audit`,
`2026/11/10/101-end-to-end-deep-sweep`) were removed from the public tree under
developerz-ai/multi-ai-router#390 because they carried internal material —
internal organisations and private repos, production hosts, database captures
and customer names. Nothing internal remains here; git history is untouched.
New plans are written per the layout below.

## Layout

```
docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/
├── overview.md      # the map: goal, context, slices in order, ranked worklist (sweeps), done-when, risks
├── 01-<aspect>.md   # one path-disjoint slice (feature area, or one Layer for a bug sweep)
├── 02-<aspect>.md
└── status.yml       # live tracker: status / owner / percent / current_focus / slices
```

- `<1NN>` = per-day counter starting at `101`. Slug = kebab-case, ≤5 words.
- Slices are path-disjoint so they can be built in parallel in one checkout. Never a single `plan.md`.
- `status.yml` is the only tracker — `.md` slices stay reference maps (no checkboxes).
- Bug sweeps: every finding carries severity, `file:line`, defect, failure scenario, fix, test.

## Workflow

1. `/planx <what you want done>` → new plan dir.
2. `/feature <plan dir>/overview.md` → executor claims it (`worked_by`), works slice by slice.
3. Executor keeps `status.yml` current (`status`, `percent`, `current_focus`, `evidence`).

Status enums: `not_started | in_progress | blocked | complete | superseded`.
