import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The two audit-evidence files the removed 2026 full-router-audit plan documents linked must
 * now be EXCLUDED by the broad ignore rules, and `.gitignore` must carry no negation that
 * re-opens them.
 *
 * The premise inverted with the purge: the internal sweep/audit plans were removed from the
 * public tree under developerz-ai/multi-ai-router#390 — `13-production.md`, the 04-/05-/06-
 * slices, and every other document that linked these two evidence files are gone — so the two
 * scoped negations that once kept `evidence/production.sql` and `04-06-unit-tests.log`
 * committable lost their only reason to exist. Without them the repo-wide `*.sql` dump rule
 * and `*.log` rule hold those paths like any other capture, and nothing may add a carve-out
 * back: the raw production captures that actually sat under that plan tree
 * (`evidence/production-db.txt`, `evidence/production-logs.json`) went with it, and an orphan
 * negation would only re-admit a path nobody should commit to again.
 *
 * Git itself is the oracle, invoked as a real `git check-ignore -v --no-index` subprocess,
 * for the same reason `bin/verify-version` is tested that way: the artifact under test is
 * git's own rule engine — last-match-wins ordering, directory rules, anchoring — and a
 * re-implemented matcher drifts from it in exactly the cases that matter here. The `-v` form
 * names the rule that decided, so the assertions pin not just the verdict but which
 * `.gitignore` line produced it, and `--no-index` keeps the verdicts rule-based (a tracked
 * path would otherwise read as eligible without any rule saying so).
 *
 * EXCLUSION IS RULE EVALUATION, NEVER ABSENCE. Both artifacts and the plan tree around them
 * are gone from the checkout, and every assertion here still passes — `git check-ignore`
 * evaluates the ignore rules against the path and never opens the file. Nothing here reads
 * production data or credentials.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** The queries-only capture the removed `13-production.md` linked, repo-relative. */
const PRODUCTION_SQL = "docs/plans/2026/10/02/102-full-router-audit/evidence/production.sql"

/** The baseline unit-run capture the removed 04-, 05- and 06- slices linked, repo-relative. */
const UNIT_TESTS_LOG = "docs/plans/2026/10/02/102-full-router-audit/04-06-unit-tests.log"

/** The committed migration the standing migrations carve-out must keep eligible. */
const MIGRATION = "packages/db/migrations/0039_catalog_refresh_attempts.sql"

/** The deciding rule `git check-ignore -v` names: file, line, and the pattern as written. */
interface Rule {
  readonly source: string
  readonly line: number
  readonly pattern: string
}

/**
 * Git's verdict for one repo-relative path. With `-v`, exit 0 means a rule decided — named on
 * stdout, and its `!` prefix alone says which way: a negation is an eligibility carve-out, any
 * other pattern an exclusion. Exit 1 means no rule matched, which is eligible. Any other exit
 * means the invocation itself broke (no repo, a bad git), which fails loudly instead of
 * reading as either verdict.
 */
function checkIgnore(rel: string): { excluded: boolean; rule: Rule | null } {
  const proc = Bun.spawnSync(["git", "check-ignore", "-v", "--no-index", "--", rel], { cwd: ROOT })
  if (proc.exitCode === 1) return { excluded: false, rule: null }
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    throw new Error(`git check-ignore exited ${proc.exitCode} for ${rel}: ${stderr}`)
  }
  // `<source>:<line>:<pattern>\t<path>`. The source may itself contain colons (an absolute
  // path), so the split point is the tab and the rest parses from its right.
  const decided = (new TextDecoder().decode(proc.stdout).split("\n")[0] ?? "").split("\t")[0] ?? ""
  const match = /^(.+):(\d+):(.+)$/.exec(decided)
  if (match === null) throw new Error(`unparsable check-ignore -v output for ${rel}: ${decided}`)
  const rule: Rule = {
    source: match[1] ?? "",
    line: Number(match[2]),
    pattern: match[3] ?? "",
  }
  return { excluded: !rule.pattern.startsWith("!"), rule }
}

/** The path must be eligible, and by the named negation — not by a missing rule, not by luck. */
function expectEligibleBy(rel: string, negation: string): void {
  const { excluded, rule } = checkIgnore(rel)
  if (excluded) {
    throw new Error(
      `${rel} is still excluded by ${rule?.source}:${rule?.line} (${rule?.pattern}); expected the negation ${negation} to decide`,
    )
  }
  expect(rule?.source).toBe(".gitignore")
  expect(rule?.pattern).toBe(negation)
}

/** The path must be excluded, and by the named rule from the named file — not by accident. */
function expectExcludedBy(rel: string, pattern: string): void {
  const { excluded, rule } = checkIgnore(rel)
  if (!excluded) {
    throw new Error(`${rel} is not excluded; expected ${pattern} to decide`)
  }
  expect(rule?.source).toBe(".gitignore")
  expect(rule?.pattern).toBe(pattern)
}

const GITIGNORE = readFileSync(`${ROOT}.gitignore`, "utf8")

describe("the evidence paths the removed plans linked", () => {
  test("evidence/production.sql is now excluded by the broad *.sql rule", () => {
    expectExcludedBy(PRODUCTION_SQL, "*.sql")
  })

  test("04-06-unit-tests.log is now excluded by the broad *.log rule", () => {
    expectExcludedBy(UNIT_TESTS_LOG, "*.log")
  })
})

describe("the broad rules keep their grip", () => {
  test("a sibling SQL dump in the same evidence directory stays ignored by *.sql", () => {
    // The dump rule never scoped to one basename — anything under that directory a capture
    // could land at is held by the broad rule alone.
    expectExcludedBy(
      "docs/plans/2026/10/02/102-full-router-audit/evidence/some-other-capture.sql",
      "*.sql",
    )
  })

  test("same-basename paths elsewhere stay ignored by the broad rules", () => {
    expectExcludedBy("scratch/production.sql", "*.sql")
    expectExcludedBy("notes/04-06-unit-tests.log", "*.log")
  })

  test("a stray log at the root stays ignored by *.log", () => {
    expectExcludedBy("debug.log", "*.log")
  })

  test("a file under logs/ is excluded by the directory's rule, not the basename's", () => {
    // Both `*.log` and `logs/` reach for this path; git excludes it through the parent
    // directory. A matcher that only ever compares the basename to one pattern cannot
    // produce this verdict — this is the case a re-implementation drifts on.
    expectExcludedBy("logs/router.log", "logs/")
  })

  test("the migrations carve-out still wins over *.sql", () => {
    expectEligibleBy(MIGRATION, "!packages/db/migrations/**/*.sql")
  })
})

describe("the .gitignore edit itself", () => {
  test("carries no negation for either artifact path", () => {
    // The carve-outs went with the plans: a line naming either path would only re-admit a
    // capture nothing should commit to again.
    const lines = GITIGNORE.split("\n")
    expect(lines.filter((line) => line === `!${PRODUCTION_SQL}`)).toHaveLength(0)
    expect(lines.filter((line) => line === `!${UNIT_TESTS_LOG}`)).toHaveLength(0)
  })

  test("leaves the migrations carve-out exactly as it was", () => {
    expect(
      GITIGNORE.split("\n").filter((line) => line === "!packages/db/migrations/**/*.sql"),
    ).toHaveLength(1)
  })
})
