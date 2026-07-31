import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AdminCredentialRepository,
  createAdminCredentialRepository,
} from "../../src/repositories/admin-credential-repository"
import { adminCredentials } from "../../src/schema/admin-credentials"

/**
 * Needs a real PostgreSQL 16+.
 *
 * The proxy-driver unit test proves the SQL shape; only a live database proves
 * the `ON CONFLICT` actually replaces (the recovery path depends on it), that
 * the singleton constraint holds, and that `updatedAt` advances while
 * `createdAt` stays. It never talks to a provider, only to the database, and
 * removes every row it wrote.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const HASH_ONE = "$argon2id$v=19$m=65536,t=2,p=1$b25l$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const HASH_TWO = "$argon2id$v=19$m=65536,t=2,p=1$dHdv$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const FIRST = new Date("2026-07-31T10:00:00.000Z")
const SECOND = new Date("2026-07-31T11:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
let repository: AdminCredentialRepository

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  repository = createAdminCredentialRepository(db)
})

afterAll(async () => {
  if (handle !== undefined) await db.delete(adminCredentials)
  await handle?.close()
})

describe.skipIf(!runnable)("the admin credential against a live database", () => {
  test("a fresh database has no row — the door is off by default", async () => {
    await db.delete(adminCredentials)
    expect(await repository.get()).toBeUndefined()
    expect(await repository.remove()).toBe(false)
  })

  test("upsert creates, then replaces — never two rows, createdAt survives", async () => {
    await db.delete(adminCredentials)

    const created = await repository.upsertHash({ passwordHash: HASH_ONE, now: FIRST })
    expect(created.passwordHash).toBe(HASH_ONE)

    const replaced = await repository.upsertHash({ passwordHash: HASH_TWO, now: SECOND })
    expect(replaced.passwordHash).toBe(HASH_TWO)
    expect(replaced.createdAt).toEqual(FIRST)
    expect(replaced.updatedAt).toEqual(SECOND)

    expect((await repository.get())?.passwordHash).toBe(HASH_TWO)
  })

  test("remove closes the door again", async () => {
    await db.delete(adminCredentials)
    await repository.upsertHash({ passwordHash: HASH_ONE, now: FIRST })

    expect(await repository.remove()).toBe(true)
    expect(await repository.get()).toBeUndefined()
  })
})
