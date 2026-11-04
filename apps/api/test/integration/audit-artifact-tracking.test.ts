import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The two audit-evidence files the 2026 full-router-audit plan documents link directly must
 * stay eligible to track.
 *
 * The defect this guards: the plan documents link two evidence files the ignore rules made
 * uncommittable — `13-production.md` links `evidence/production.sql`, swallowed by the
 * repo-wide `*.sql` database-dump rule, and the `04-`/`05-`/`06-` slices all link
 * `04-06-unit-tests.log`, swallowed by the repo-wide `*.log` rule — so those links were dead
 * on every fresh checkout: the evidence could never be committed, because the same rules that
 * keep dumps and logs out of the tree matched these paths too. Two scoped negations in
 * `.gitignore` carve out exactly those paths; everything else the broad rules hold stays
 * held, and the standing migrations carve-out is untouched.
 *
 * Git itself is the oracle, invoked as a real `git check-ignore -v --no-index` subprocess,
 * for the same reason `bin/verify-version` is tested that way: the artifact under test is
 * git's own rule engine — last-match-wins ordering, directory rules, anchoring — and a
 * re-implemented matcher drifts from it in exactly the cases that matter here. The `-v` form
 * names the rule that decided, so the assertions pin not just the verdict but which
 * `.gitignore` line produced it, and `--no-index` keeps the verdicts rule-based (a tracked
 * path would otherwise read as eligible without any rule saying so).
 *
 * ELIGIBILITY IS RULE EVALUATION, NEVER PRESENCE. Both artifacts are absent from the tree and
 * this change adds none of them — regenerating them is out of scope — and every assertion
 * here passes with them absent, because `git check-ignore` evaluates the ignore rules
 * against the path and never opens the file. Nothing here reads production data or
 * credentials: `production.sql` is a queries-only capture, unlike the pg_dump output the
 * `*.sql` rule exists for.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** The queries-only capture `13-production.md` links, repo-relative. */
const PRODUCTION_SQL = "docs/plans/2026/10/02/102-full-router-audit/evidence/production.sql"

/** The baseline unit-run capture the 04-, 05- and 06- slices link, repo-relative. */
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

/** The 1-based line of the .gitignore line that equals `exact`, failing loudly when absent. */
function gitignoreLine(exact: string): number {
  const at = GITIGNORE.split("\n").indexOf(exact)
  if (at === -1) throw new Error(`.gitignore has no line exactly ${JSON.stringify(exact)}`)
  return at + 1
}

describe("the audit evidence the plan documents link", () => {
  test("evidence/production.sql is eligible to track, by its own negation", () => {
    expectEligibleBy(PRODUCTION_SQL, `!${PRODUCTION_SQL}`)
  })

  test("04-06-unit-tests.log is eligible to track, by its own negation", () => {
    expectEligibleBy(UNIT_TESTS_LOG, `!${UNIT_TESTS_LOG}`)
  })
})

describe("the broad rules keep their grip", () => {
  test("a sibling SQL dump in the same evidence directory stays ignored by *.sql", () => {
    // The negation is the one path, not the directory or the basename — anything else the
    // dump rule caught before must still be caught.
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
  test("carries each negation exactly once, after the broad rule it escapes", () => {
    // Ordering is load-bearing: last match wins, so a negation placed above its broad rule
    // would be dead text while the check-ignore assertions above still fail loudly.
    expect(gitignoreLine(`!${PRODUCTION_SQL}`)).toBeGreaterThan(gitignoreLine("*.sql"))
    expect(gitignoreLine(`!${UNIT_TESTS_LOG}`)).toBeGreaterThan(gitignoreLine("*.log"))
    const lines = GITIGNORE.split("\n")
    expect(lines.filter((line) => line === `!${PRODUCTION_SQL}`)).toHaveLength(1)
    expect(lines.filter((line) => line === `!${UNIT_TESTS_LOG}`)).toHaveLength(1)
  })

  test("leaves the migrations carve-out exactly as it was", () => {
    expect(
      GITIGNORE.split("\n").filter((line) => line === "!packages/db/migrations/**/*.sql"),
    ).toHaveLength(1)
  })
})
