import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import {
  createModelCatalogRepository,
  type ModelCatalogRepository,
} from "../../src/repositories/model-catalog-repository"
import { accounts } from "../../src/schema/accounts"

/**
 * Needs a real PostgreSQL 16+.
 *
 * Three things here cannot be proved against a stub, and one of them has already bitten this
 * repository once: a hand-written statement that every caller was tested against a mock of turned
 * out to be invalid SQL, and the suite stayed green while the endpoint answered `500`.
 *
 * - **Replacement is atomic and total.** A model the upstream stopped listing has to leave, and a
 *   half-applied set is a router that appears to have lost models it still serves.
 * - **The cascade is real.** Deleting an account must take its catalog with it; a description of a
 *   row that no longer exists is not stale, it is meaningless.
 * - **`lastRefreshedAt` aggregates.** The sweep orders its batch on this, and an ordering that
 *   silently returned nothing would starve every account after the first tick.
 *
 * It never talks to a provider, only to the database, and removes every row it wrote.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const EARLIER = new Date("2026-07-28T09:00:00.000Z")
const LATER = new Date("2026-07-28T12:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
let accountsRepo: AccountRepository
let catalog: ModelCatalogRepository

const accountIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  accountsRepo = createAccountRepository(db)
  catalog = createModelCatalogRepository(db)
})

afterAll(async () => {
  // No explicit `model_catalog` delete: the cascade is the point, and if it is broken the account
  // delete fails loudly here rather than leaving rows behind quietly.
  if (handle !== undefined && accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, accountIds))
  }
  await handle?.close()
})

async function seedAccount() {
  const row = await accountsRepo.create({
    label: `test-catalog-${accountIds.length}-${Date.now()}`,
    provider: "zai",
  })
  accountIds.push(row.id)
  return row.id
}

describe.skipIf(!runnable)("the model catalog against a live database", () => {
  test("stores a listing, nulls and all", async () => {
    const accountId = await seedAccount()

    await catalog.replaceForAccount(
      accountId,
      [
        {
          modelId: "glm-4.6",
          contextTokens: 204_800,
          maxOutputTokens: 131_072,
          contextSource: "shipped",
        },
        // Unknown, which is a real state: an id in neither the listing nor the shipped table.
        { modelId: "glm-99", contextTokens: null, maxOutputTokens: null, contextSource: null },
      ],
      LATER,
    )

    const rows = await catalog.listForAccounts([accountId])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      modelId: "glm-4.6",
      contextTokens: 204_800,
      maxOutputTokens: 131_072,
      contextSource: "shipped",
    })
    // Null survives the round trip as null, never as 0 — a client reading a zero window as
    // "unlimited" would build a request the upstream rejects.
    expect(rows[1]).toMatchObject({ modelId: "glm-99", contextTokens: null, contextSource: null })
  })

  test("a second refresh replaces the set — a retired model actually leaves", async () => {
    const accountId = await seedAccount()

    await catalog.replaceForAccount(
      accountId,
      [
        { modelId: "old", contextTokens: 1_000, maxOutputTokens: null, contextSource: "upstream" },
        { modelId: "kept", contextTokens: 2_000, maxOutputTokens: null, contextSource: "upstream" },
      ],
      EARLIER,
    )
    await catalog.replaceForAccount(
      accountId,
      [
        { modelId: "kept", contextTokens: 3_000, maxOutputTokens: null, contextSource: "upstream" },
        { modelId: "new", contextTokens: 4_000, maxOutputTokens: null, contextSource: "upstream" },
      ],
      LATER,
    )

    const rows = await catalog.listForAccounts([accountId])

    expect(rows.map((row) => row.modelId)).toEqual(["kept", "new"])
    // An upsert-only refresh would have left `old` behind and re-reported `kept` at its old size.
    expect(rows[0]?.contextTokens).toBe(3_000)
  })

  test("an upstream that now lists nothing clears the catalog rather than keeping a fiction", async () => {
    const accountId = await seedAccount()

    await catalog.replaceForAccount(
      accountId,
      [{ modelId: "gone", contextTokens: null, maxOutputTokens: null, contextSource: null }],
      EARLIER,
    )
    await catalog.replaceForAccount(accountId, [], LATER)

    expect(await catalog.listForAccounts([accountId])).toEqual([])
  })

  test("lastRefreshedAt reports the newest row per account, and omits accounts with none", async () => {
    const swept = await seedAccount()
    const untouched = await seedAccount()

    await catalog.replaceForAccount(
      swept,
      [{ modelId: "a", contextTokens: null, maxOutputTokens: null, contextSource: null }],
      EARLIER,
    )
    await catalog.replaceForAccount(
      swept,
      [{ modelId: "b", contextTokens: null, maxOutputTokens: null, contextSource: null }],
      LATER,
    )

    const ages = await catalog.lastRefreshedAt()
    const at = (id: string) => ages.find((age) => age.accountId === id)

    expect(at(swept)?.refreshedAt).toEqual(LATER)
    // Absent, not null-dated: "never refreshed" and "refreshed and found nothing" are different
    // facts, and the sweep's ordering depends on being able to tell them apart.
    expect(at(untouched)).toBeUndefined()
  })

  test("an empty ask is no query at all", async () => {
    expect(await catalog.listForAccounts([])).toEqual([])
  })

  test("deleting an account takes its catalog with it", async () => {
    const accountId = await seedAccount()
    await catalog.replaceForAccount(
      accountId,
      [{ modelId: "doomed", contextTokens: null, maxOutputTokens: null, contextSource: null }],
      LATER,
    )

    // Without ON DELETE CASCADE this throws a foreign-key violation instead.
    await db.delete(accounts).where(inArray(accounts.id, [accountId]))
    accountIds.splice(accountIds.indexOf(accountId), 1)

    expect(await catalog.listForAccounts([accountId])).toEqual([])
  })
})
