import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * The 102 router-audit plan links two artifacts from its own documents: the read-only production
 * queries (`evidence/production.sql`) and the captured baseline unit-test run
 * (`04-06-unit-tests.log`). Both sit behind ignore rules meant for a different thing — `*.sql` is
 * there to keep pg_dump output (encrypted credential columns) out of the repository, `*.log` is
 * there to keep runtime application logs out of it. A link to a path git refuses to track is a
 * broken reference: the plan's evidence cannot be verified from a fresh checkout.
 *
 * The fix is two negations naming those two paths EXACTLY. A blanket negation of every SQL or
 * log file under docs/ would satisfy "the two artifacts are trackable" while re-admitting every
 * dump and runtime log under docs/, so the guard below pins the narrow form: the artifacts are
 * trackable, the neighbouring dump and log paths are not, and the plan's links still name the
 * exact paths the negations name.
 *
 * The matching is done here rather than by shelling out to `git check-ignore`: the verdict is a
 * property of the repository's own ignore file, and this way the guard runs anywhere the suite
 * runs, with no git process and no working tree state involved. The rules it implements are
 * git's own — see `excluded`.
 */

const ROOT = resolve(import.meta.dir, "../../../..")

/** The repository's ignore file, as the single source of truth for what is excluded. */
const IGNORE_FILE = readFileSync(`${ROOT}/.gitignore`, "utf8")

/** The audit plan directory, relative to the repository root. */
const PLAN = "docs/plans/2026/10/02/102-full-router-audit"

/** The two artifacts the plan links, relative to the repository root. */
const PRODUCTION_SQL = `${PLAN}/evidence/production.sql`
const UNIT_TEST_LOG = `${PLAN}/04-06-unit-tests.log`

/**
 * The plan documents that link the artifacts, and the link target each one must carry.
 *
 * The links are the artifact's index, so they are what the negations track: if a document moves
 * its link, the ignore rule must follow, and the drift surfaces here rather than as a dead
 * reference on a fresh checkout.
 */
const LINKS: readonly { readonly doc: string; readonly target: string }[] = [
  { doc: `${PLAN}/13-production.md`, target: "evidence/production.sql" },
  { doc: `${PLAN}/04-providers.md`, target: "04-06-unit-tests.log" },
  { doc: `${PLAN}/05-claude-sdk.md`, target: "04-06-unit-tests.log" },
  { doc: `${PLAN}/06-translation.md`, target: "04-06-unit-tests.log" },
]

/**
 * Paths that must stay ignored. Each is a neighbour of the two artifacts, or a path the broad
 * rules were written for: a dump, a runtime log, a file inside an ignored directory.
 */
const STILL_IGNORED: readonly string[] = [
  "dump.sql",
  "data/x.sql",
  "app.log",
  "logs/app.log",
  `${PLAN}/evidence/other.sql`,
  `${PLAN}/evidence/other.log`,
  `${PLAN}/other.sql`,
  `${PLAN}/other.log`,
  `${PLAN}/evidence/nested/dump.sql`,
]

describe("the audit artifacts are eligible for tracking", () => {
  test("neither artifact is excluded by the repository's ignore rules", () => {
    expect(excluded(PRODUCTION_SQL)).toBe(false)
    expect(excluded(UNIT_TEST_LOG)).toBe(false)
  })

  test("the committed migrations stay trackable", () => {
    // The pre-existing negation, unchanged by this work: a swallowed migration leaves a
    // meta/_journal.json that references a file nobody else has.
    expect(excluded("packages/db/migrations/0000_spotty_vin_gonzales.sql")).toBe(false)
  })
})

describe("unrelated SQL and log paths remain ignored", () => {
  for (const path of STILL_IGNORED) {
    test(`${path} is excluded`, () => {
      expect(excluded(path)).toBe(true)
    })
  }
})

describe("the ignore rules are narrow", () => {
  test("every SQL or log negation names a path on the allowlist", () => {
    // A blanket negation of the SQL or log rules — one that re-admits a whole directory of
    // them — is how the artifacts become trackable and every dump and runtime log under
    // docs/ comes with them. Only the three named paths may be re-included.
    expect(sqlAndLogNegations().sort()).toEqual(
      ["!packages/db/migrations/**/*.sql", `!${PRODUCTION_SQL}`, `!${UNIT_TEST_LOG}`].sort(),
    )
  })

  test("no negation widens to a directory of files", () => {
    // A trailing `**` or `/` on a negation makes it cover a tree rather than one path.
    for (const rule of negations()) {
      expect(rule).not.toMatch(/\*\*$/)
      expect(rule).not.toMatch(/\/$/)
    }
  })

  test("the broad SQL and log rules are still stated", () => {
    // The negations are exceptions to these two rules; without the rules there is nothing to
    // except, and a later reader would not know what the negations are for.
    const patterns = rules().map((rule) => rule.pattern)
    expect(patterns).toContain("*.sql")
    expect(patterns).toContain("*.log")
  })

  test("each artifact's negation comes after the rule it overrides", () => {
    // Git applies the last matching rule, so a negation placed above `*.sql` / `*.log` does
    // nothing at all.
    const order = rules().map((rule) => rule.pattern)
    expect(order.indexOf(PRODUCTION_SQL)).toBeGreaterThan(order.indexOf("*.sql"))
    expect(order.indexOf(UNIT_TEST_LOG)).toBeGreaterThan(order.indexOf("*.log"))
  })
})

describe("an excluded parent directory cannot be re-included", () => {
  test("a negation naming a file inside an excluded directory has no effect", () => {
    // Git never descends into an excluded directory, so `!logs/keep.log` cannot re-include
    // `logs/keep.log`: the excluded `logs/` decides the whole subtree.
    expect(excluded("logs/keep.log", rules("logs/\n*.log\n!logs/keep.log\n"))).toBe(true)
  })

  test("the same negation re-includes the file when the parent directory is not excluded", () => {
    // The control: without `logs/` there is no excluded parent, so the negation stands. The pair
    // fails if the verdict is a blanket "always excluded" or a blanket "last match wins".
    expect(excluded("logs/keep.log", rules("*.log\n!logs/keep.log\n"))).toBe(false)
  })

  test("where the negation is defined does not matter", () => {
    expect(excluded("logs/keep.log", rules("!logs/keep.log\nlogs/\n*.log\n"))).toBe(true)
  })
})

describe("the plan documents still link the artifacts", () => {
  for (const { doc, target } of LINKS) {
    test(`${doc} links ${target}`, () => {
      const text = readFileSync(`${ROOT}/${doc}`, "utf8")
      expect(text).toContain(`](${target})`)
    })
  }
})

/** The ignore rules that re-include a path, in the order the file states them. */
function negations(): string[] {
  return rules()
    .filter((rule) => rule.negated)
    .map((rule) => `!${rule.pattern}`)
}

/** The negations that re-include a SQL or log file — the rules this change touches. */
function sqlAndLogNegations(): string[] {
  return negations().filter((rule) => rule.endsWith(".sql") || rule.endsWith(".log"))
}

/** One rule of an ignore file: its pattern, whether it re-includes, and whether it is directory-only. */
type IgnoreRule = { pattern: string; negated: boolean; directoryOnly: boolean }

/**
 * An ignore file's rules, in file order: git applies the last match that wins.
 *
 * Defaults to the repository's own ignore file; a synthetic one pins git's rules against rules
 * this repository does not happen to state.
 */
function rules(text: string = IGNORE_FILE): IgnoreRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!")
      const pattern = negated ? line.slice(1) : line
      return { pattern, negated, directoryOnly: pattern.endsWith("/") }
    })
}

/**
 * Whether git would exclude a repository-relative path.
 *
 * Git's rules: the last matching pattern decides, a leading `!` re-includes, a pattern with a
 * slash anywhere but its end is anchored to the ignore file's directory, a trailing slash matches
 * directories only, and `*` stops at a slash while `**` crosses one.
 *
 * Git also does not descend into an excluded directory: "It is not possible to re-include a file
 * if a parent directory of that file is excluded" — patterns on a file inside an excluded
 * directory have no effect, no matter where they are defined. So the path is resolved from the
 * top, one directory at a time, and an excluded parent decides the whole subtree.
 */
function excluded(path: string, ignoreRules: IgnoreRule[] = rules()): boolean {
  const segments = path.split("/")

  for (let depth = 1; depth < segments.length; depth += 1) {
    if (isExcluded(segments.slice(0, depth), true, ignoreRules)) return true
  }

  return isExcluded(segments, false, ignoreRules)
}

/**
 * Whether the last rule matching a path excludes it.
 *
 * Only the rules matching the path itself count — a rule matching an ancestor directory is the
 * ancestor's own decision, which is what `excluded` resolves one level at a time.
 */
function isExcluded(segments: string[], isDirectory: boolean, ignoreRules: IgnoreRule[]): boolean {
  let ignored = false

  for (const rule of ignoreRules) {
    if (rule.directoryOnly && !isDirectory) continue
    if (!matches(rule.pattern, segments)) continue
    ignored = !rule.negated
  }

  return ignored
}

/**
 * Whether an ignore pattern matches a path, given as its segments.
 *
 * A pattern with a slash in the middle is anchored to the repository root, which is where this
 * repository's single ignore file lives; a pattern without one matches at any depth. A trailing
 * slash marks a directory-only pattern and does not anchor it: `logs/` matches a `logs` directory
 * anywhere below the ignore file.
 */
function matches(pattern: string, segments: string[]): boolean {
  const body = pattern.replace(/\/$/, "")
  const anchored = body.includes("/")
  const candidates = anchored ? [segments] : suffixes(segments)

  return candidates.some((candidate) => matchesSegments(body, candidate))
}

/** Every tail of the path, longest first: the depths an unanchored pattern may match at. */
function suffixes(segments: string[]): string[][] {
  const result: string[][] = []
  for (let start = 0; start < segments.length; start += 1) {
    result.push(segments.slice(start))
  }
  return result
}

/** Whether a `/`-separated pattern matches a `/`-separated path segment by segment. */
function matchesSegments(pattern: string, path: string[]): boolean {
  const parts = pattern.split("/")
  const isGlobstar = parts.some((part) => part === "**")
  if (!isGlobstar) return matchesLiteral(parts, path)
  return matchesGlobstar(parts, path)
}

/** Whether a pattern with no `**` matches the path exactly segment by segment. */
function matchesLiteral(parts: string[], path: string[]): boolean {
  if (parts.length !== path.length) return false
  return parts.every((part, index) => matchesSegment(part, path[index] ?? ""))
}

/**
 * Whether a pattern containing `**` matches the path.
 *
 * Git's rule: a `**` that is a whole path segment, followed by a slash, matches zero or more
 * directories. So `a` + slash + `**` + slash + `b` matches `a/b` as well as `a/x/y/b`, and a
 * trailing `**` matches everything inside the directory named before it.
 */
function matchesGlobstar(parts: string[], path: string[]): boolean {
  const first = parts[0] ?? ""
  if (first !== "**") {
    const head = path[0]
    if (head === undefined || !matchesSegment(first, head)) return false
    if (parts.length === 1) return true
    return matchesGlobstar(parts.slice(1), path.slice(1))
  }

  // A trailing `**` matches everything below this point, including nothing at all.
  if (parts.length === 1) return true

  // `**/` consumes zero or more path segments.
  for (let depth = 0; depth <= path.length; depth += 1) {
    if (matchesGlobstar(parts.slice(1), path.slice(depth))) return true
  }
  return false
}

/** Whether one path segment matches one pattern segment. */
function matchesSegment(pattern: string, segment: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === segment
  return matchesGlob(pattern, segment)
}

/**
 * Whether a segment matches a pattern segment holding `*` wildcards.
 *
 * `*` matches any run of characters within one segment, which is all the repository's ignore
 * file uses (`*.sql`, `npm-debug.log*`).
 */
function matchesGlob(pattern: string, segment: string): boolean {
  const parts = pattern.split("*")
  if (parts.length === 1) return pattern === segment

  let index = 0
  for (let part = 0; part < parts.length; part += 1) {
    const piece = parts[part] ?? ""
    if (piece.length === 0) continue
    const found = segment.indexOf(piece, index)
    if (found === -1) return false
    if (part === 0 && found !== 0) return false
    index = found + piece.length
  }
  const last = parts[parts.length - 1] ?? ""
  if (last.length > 0 && !segment.endsWith(last)) return false
  return true
}
