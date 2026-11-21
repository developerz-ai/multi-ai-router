import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import { type AccountRow, accounts } from "../../src/schema/accounts"

/**
 * Needs a real PostgreSQL 18.
 *
 * `editSupportedModels` exists so two writers of one account's model list cannot lose each other's
 * edit. Only a live database can show it: the lost update is two transactions reading the same row
 * before either writes, and the row lock is what serializes them.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const NOW = new Date("2026-11-20T12:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
let repository: AccountRepository
const accountIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  // More than one connection: each concurrent edit needs its own transaction.
  handle = createDatabase({ url, maxConnections: 4 })
  db = handle.db
  repository = createAccountRepository(db)
})

afterAll(async () => {
  if (handle !== undefined && accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, accountIds))
  }
  await handle?.close()
})

async function seed(supportedModels: string[]) {
  const row = await repository.create({
    label: `test-supported-models-${accountIds.length}-${crypto.randomUUID()}`,
    provider: "openrouter",
    status: "active",
    supportedModels,
  })
  accountIds.push(row.id)
  return row
}

/** The add-one rule, as a caller would write it: read the locked row, append one id. */
const addOne = (model: string) => (row: AccountRow) => ({
  kind: "write" as const,
  supportedModels: [...(row.supportedModels ?? []), model],
  supportedModelsRemoved: row.supportedModelsRemoved,
})

describe.skipIf(!runnable)("editSupportedModels against a live database", () => {
  test("two concurrent add-one edits both land", async () => {
    const row = await seed(["a/base"])

    await Promise.all([
      repository.editSupportedModels({ id: row.id, now: NOW, decide: addOne("a/one") }),
      repository.editSupportedModels({ id: row.id, now: NOW, decide: addOne("a/two") }),
    ])

    const after = await repository.findById(row.id)
    expect([...(after?.supportedModels ?? [])].sort()).toEqual(["a/base", "a/one", "a/two"])
  })

  test("many concurrent add-one edits all land", async () => {
    const row = await seed([])
    const ids = Array.from({ length: 8 }, (_, index) => `m/${index}`)

    await Promise.all(
      ids.map((id) => repository.editSupportedModels({ id: row.id, now: NOW, decide: addOne(id) })),
    )

    const after = await repository.findById(row.id)
    expect([...(after?.supportedModels ?? [])].sort()).toEqual(ids)
  })

  test("a skip writes nothing and returns the row as it stands", async () => {
    const row = await seed(["a/base"])
    const result = await repository.editSupportedModels({
      id: row.id,
      now: NOW,
      decide: () => ({ kind: "skip" }),
    })
    expect(result.kind).toBe("skipped")
    expect((await repository.findById(row.id))?.updatedAt).toEqual(row.updatedAt)
  })

  test("stores the removal memory beside the list", async () => {
    const row = await seed(["a/base", "a/gone"])
    const removal = { model: "a/gone", removedAt: NOW.toISOString(), by: "ops@example.test" }
    const result = await repository.editSupportedModels({
      id: row.id,
      now: NOW,
      decide: () => ({
        kind: "write",
        supportedModels: ["a/base"],
        supportedModelsRemoved: [removal],
      }),
    })
    expect(result.kind).toBe("written")
    const after = await repository.findById(row.id)
    expect(after?.supportedModels).toEqual(["a/base"])
    expect(after?.supportedModelsRemoved).toEqual([removal])
  })

  test("an unknown id is not_found, and nothing is decided", async () => {
    let decided = false
    const result = await repository.editSupportedModels({
      id: crypto.randomUUID(),
      now: NOW,
      decide: () => {
        decided = true
        return { kind: "skip" }
      },
    })
    expect(result.kind).toBe("not_found")
    expect(decided).toBe(false)
  })
})
