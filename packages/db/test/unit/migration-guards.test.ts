import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Re-runs in the normal path are skipped by drizzle's journal, but a restore replayed over a newer
 * schema runs the SQL itself. From 0044 on (plus the two enum additions that lacked it), every
 * schema-changing statement must therefore be a no-op when its effect is already there.
 */
const folder = fileURLToPath(new URL("../../migrations", import.meta.url))
const FIRST_GUARDED = 44
const ALSO_GUARDED = ["0041_sparkling_inhumans.sql", "0043_fantastic_norrin_radd.sql"]

function guardedFiles(): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => Number(name.slice(0, 4)) >= FIRST_GUARDED || ALSO_GUARDED.includes(name))
    .sort()
}

/** Statements with their comment lines removed, one per drizzle breakpoint. */
function statements(file: string): string[] {
  return readFileSync(`${folder}/${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((part) => part.length > 0)
}

/** The unguarded forms, each paired with what makes it safe to replay. */
const RULES: readonly { readonly name: string; readonly unsafe: (s: string) => boolean }[] = [
  { name: "ADD VALUE needs IF NOT EXISTS", unsafe: (s) => /ADD VALUE (?!IF NOT EXISTS)/i.test(s) },
  {
    name: "ADD COLUMN needs IF NOT EXISTS",
    unsafe: (s) => /ADD COLUMN (?!IF NOT EXISTS)/i.test(s),
  },
  {
    name: "CREATE INDEX needs IF NOT EXISTS",
    unsafe: (s) => /CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(?!IF NOT EXISTS)/i.test(s),
  },
  {
    name: "CREATE TABLE needs IF NOT EXISTS",
    unsafe: (s) => /CREATE TABLE (?!IF NOT EXISTS)/i.test(s),
  },
  {
    name: "DROP INDEX needs IF EXISTS",
    unsafe: (s) => /DROP INDEX (CONCURRENTLY )?(?!IF EXISTS)/i.test(s),
  },
  { name: "DROP COLUMN needs IF EXISTS", unsafe: (s) => /DROP COLUMN (?!IF EXISTS)/i.test(s) },
]

describe("migration replay guards", () => {
  test("covers at least 0044 and the two enum additions", () => {
    const files = guardedFiles()
    expect(files).toContain("0044_index_hygiene.sql")
    for (const name of ALSO_GUARDED) expect(files).toContain(name)
  })

  for (const file of guardedFiles()) {
    test(`${file}: every statement is replay-safe`, () => {
      const all = statements(file)
      const violations = all.flatMap((statement) =>
        RULES.filter((rule) => rule.unsafe(statement)).map((rule) => `${rule.name}: ${statement}`),
      )
      // ADD CONSTRAINT has no IF NOT EXISTS: it must follow a DROP CONSTRAINT IF EXISTS of the name.
      all.forEach((statement, index) => {
        const added = /ADD CONSTRAINT "([^"]+)"/i.exec(statement)?.[1]
        if (added === undefined) return
        const dropped = all
          .slice(0, index)
          .some((earlier) => earlier.includes(`DROP CONSTRAINT IF EXISTS "${added}"`))
        if (!dropped) violations.push(`ADD CONSTRAINT needs a prior DROP IF EXISTS: ${added}`)
      })
      expect(violations).toEqual([])
    })
  }

  test("0044 builds its indexes before it takes any ACCESS EXCLUSIVE lock", () => {
    const all = statements("0044_index_hygiene.sql")
    const lastCreate = all.findLastIndex((s) => /CREATE INDEX/i.test(s))
    const firstExclusive = all.findIndex((s) => /DROP INDEX|ADD CONSTRAINT/i.test(s))
    expect(lastCreate).toBeLessThan(firstExclusive)
  })
})
