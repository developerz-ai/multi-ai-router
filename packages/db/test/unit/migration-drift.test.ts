import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { getTableColumns, getTableName, isTable, type Table } from "drizzle-orm"
import * as schemaEnums from "../../src/schema/enums"
import * as schema from "../../src/schema/index"

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
 * A column drifts the same way, one step softer: adding `accounts.priority` to the schema
 * compiles clean and the deployed database still rejects every write that names it, on a schema
 * that migrated successfully. So the guard sweeps columns too — every table the schema barrel
 * exports against the same table in the committed snapshot — and names the table and the column
 * it is missing.
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

/** Every table the schema barrel exports — the Drizzle tables, not the enums beside them. */
const SCHEMA_TABLES: readonly Table[] = Object.values(schema).filter(isTable)

/** Every column the last migration leaves behind, by table and then by column name. */
function migratedColumns(): ReadonlyMap<string, ReadonlySet<string>> {
  const snapshot = asRecord(readJson(latestSnapshotName()), "snapshot")
  const tables = asRecord(snapshot.tables, "snapshot.tables")
  const migrated = new Map<string, ReadonlySet<string>>()

  for (const entry of Object.values(tables)) {
    const table = asRecord(entry, "snapshot table")
    const name = table.name
    if (typeof name !== "string") throw new Error("malformed snapshot table")
    const columns = asRecord(table.columns, `snapshot table ${name} columns`)
    const columnNames = new Set<string>()
    for (const column of Object.values(columns)) {
      const columnName = asRecord(column, `snapshot column of ${name}`).name
      if (typeof columnName !== "string") throw new Error("malformed snapshot column")
      columnNames.add(columnName)
    }
    migrated.set(name, columnNames)
  }
  return migrated
}

/** One table's worth of drift: the columns the committed snapshot does not carry. */
interface ColumnDrift {
  readonly table: string
  readonly missing: readonly string[]
}

/**
 * The schema columns the committed snapshot does not carry, per table.
 *
 * A table the snapshot never created is reported with every one of its columns missing: the
 * missing table *is* the drift, and skipping it would report a clean sweep over a schema the
 * database cannot serve.
 */
function findColumnDrift(
  tables: readonly Table[],
  migrated: ReadonlyMap<string, ReadonlySet<string>>,
): readonly ColumnDrift[] {
  const drift: ColumnDrift[] = []

  for (const table of tables) {
    const name = getTableName(table)
    const declared = Object.values(getTableColumns(table)).map((column) => column.name)
    const inSnapshot = migrated.get(name)
    const missing = inSnapshot
      ? declared.filter((column) => !inSnapshot.has(column))
      : [...declared]
    if (missing.length > 0) drift.push({ table: name, missing })
  }

  return drift
}

/** The report a failing run prints: the table and the column it is missing. */
function describeDrift(drift: readonly ColumnDrift[]): string {
  return drift
    .map((entry) => `${entry.table}: missing column(s) ${entry.missing.join(", ")}`)
    .join("; ")
}

/** The first schema table by database name — a real table to build the fixtures from. */
function fixtureTable(): Table {
  const sorted = [...SCHEMA_TABLES].sort((a, b) => getTableName(a).localeCompare(getTableName(b)))
  const table = sorted[0]
  if (!table) throw new Error("the schema barrel exports no tables")
  return table
}

describe("committed migrations carry every schema column", () => {
  test("the schema barrel exports tables — an empty sweep would pass vacuously", () => {
    expect(SCHEMA_TABLES.length).toBeGreaterThan(0)
  })

  test("every table the snapshot declares is found in the schema", () => {
    // The sweep is only as good as its discovery: a barrel export that stopped resolving would
    // leave it comparing nothing and passing. The snapshot is the independent list of what the
    // database holds, so a table it declares that the sweep never saw fails here.
    const declared = new Set(SCHEMA_TABLES.map((table) => getTableName(table)))
    const unseen = [...migratedColumns().keys()].filter((name) => !declared.has(name))
    expect(unseen).toEqual([])
  })

  test("every schema column exists in the latest committed migration snapshot", () => {
    const drift = findColumnDrift(SCHEMA_TABLES, migratedColumns())
    expect(describeDrift(drift)).toBe("")
  })
})

describe("the column sweep reports what it finds", () => {
  test("a column the snapshot lacks is reported with its table and its name", () => {
    // The fixture is a mismatched pair built from the real schema: the snapshot side is the
    // schema's own columns minus one, so the two differ by exactly one column whichever way the
    // tree moves. A preloaded report would pass even with the comparison removed.
    const table = fixtureTable()
    const tableName = getTableName(table)
    const declared = Object.values(getTableColumns(table)).map((column) => column.name)
    const absent = declared[declared.length - 1]
    if (absent === undefined) throw new Error("the fixture table has no columns")
    const inSnapshot = new Set(declared.filter((column) => column !== absent))
    expect(declared.length).toBe(inSnapshot.size + 1)

    const drift = findColumnDrift(
      [table],
      new Map<string, ReadonlySet<string>>([[tableName, inSnapshot]]),
    )

    expect(drift).toHaveLength(1)
    expect(drift[0]?.table).toBe(tableName)
    expect(drift[0]?.missing).toEqual([absent])
    const report = describeDrift(drift)
    expect(report).toContain(tableName)
    expect(report).toContain(absent)
  })

  test("a table the snapshot never created is reported with every column missing", () => {
    const table = fixtureTable()
    const tableName = getTableName(table)
    const declared = Object.values(getTableColumns(table)).map((column) => column.name)

    const drift = findColumnDrift([table], new Map<string, ReadonlySet<string>>())

    expect(drift).toHaveLength(1)
    expect(drift[0]?.table).toBe(tableName)
    expect(drift[0]?.missing).toEqual(declared)
  })
})
