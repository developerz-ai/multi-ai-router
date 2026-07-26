import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as schemaEnums from "../../src/schema/enums"

/**
 * A Postgres enum is the one part of this schema a code change alone cannot move. Adding a
 * `ProviderId` in `@multi-ai-router/core` re-types `providerId` here and compiles clean, but the
 * deployed database still rejects the value — every write naming the new provider fails at runtime,
 * on a schema that migrated successfully.
 *
 * So the assertion is drift between the enums this package declares and the ones the **committed
 * migrations** actually produce. Reading the checked-in snapshot is the assertion, not a shortcut
 * around one: the artifact under test is the file `drizzle-kit generate` wrote and the migrator will
 * replay. Enums are discovered from the schema module rather than listed, so one added tomorrow is
 * covered without anyone remembering to add it here.
 *
 * Parsed by hand rather than with Zod, which this package does not depend on. A malformed snapshot
 * throws, and a throw is the right outcome: there is nothing to degrade to.
 */

const META = fileURLToPath(new URL("../../migrations/meta/", import.meta.url))

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(META, name), "utf8"))
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`)
  }
  return value as Record<string, unknown>
}

/** The migration the journal names last — the state the database ends up in. */
function latestSnapshotName(): string {
  const entries = asRecord(readJson("_journal.json"), "_journal.json").entries
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("_journal.json has no entries")

  const indices = entries.map((entry) => {
    const idx = asRecord(entry, "journal entry").idx
    if (typeof idx !== "number") throw new Error("journal entry has no numeric idx")
    return idx
  })
  return `${String(Math.max(...indices)).padStart(4, "0")}_snapshot.json`
}

/** Every enum the last migration leaves behind, by its unqualified name. */
function migratedEnums(): ReadonlyMap<string, readonly string[]> {
  const snapshot = asRecord(readJson(latestSnapshotName()), "snapshot")
  const enums = asRecord(snapshot.enums, "snapshot.enums")
  const migrated = new Map<string, readonly string[]>()

  for (const entry of Object.values(enums)) {
    const { name, values } = asRecord(entry, "snapshot enum")
    if (typeof name !== "string" || !Array.isArray(values))
      throw new Error("malformed snapshot enum")
    migrated.set(name, values as readonly string[])
  }
  return migrated
}

interface DeclaredEnum {
  readonly enumName: string
  readonly enumValues: readonly string[]
}

function isDeclaredEnum(value: unknown): value is DeclaredEnum {
  if (value === null || (typeof value !== "function" && typeof value !== "object")) return false
  const candidate = value as Partial<DeclaredEnum>
  return typeof candidate.enumName === "string" && Array.isArray(candidate.enumValues)
}

const DECLARED: readonly DeclaredEnum[] = Object.values(schemaEnums).filter(isDeclaredEnum)

describe("committed migrations carry every declared enum value", () => {
  test("the schema declares enums at all — an empty sweep would pass vacuously", () => {
    expect(DECLARED.length).toBeGreaterThan(0)
  })

  for (const declared of DECLARED) {
    test(`${declared.enumName} is migrated with exactly the values the schema declares`, () => {
      // A missing entry means the type was never created: the enum is new and its migration is the
      // thing that was forgotten, which is the failure this test exists for.
      expect(migratedEnums().get(declared.enumName)).toEqual([...declared.enumValues])
    })
  }
})
