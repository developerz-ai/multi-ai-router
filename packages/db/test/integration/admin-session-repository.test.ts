import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { inArray, sql } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AdminSessionRepository,
  createAdminSessionRepository,
} from "../../src/repositories/admin-session-repository"
import { type AdminSessionRow, adminSessions } from "../../src/schema/admin-sessions"

/**
 * Needs a real PostgreSQL 18.
 *
 * Only a live database proves the `ON CONFLICT` slide touches exactly the two
 * columns it claims to, that the bounded purge honours both expiry bounds and
 * its limit, and that a delete reports whether a row was there. It never talks
 * to a provider, only to the database, and removes every row it wrote — by
 * fixture prefix, so a dev operator's live console session in the same table
 * is never touched.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const PREFIX = `test-admin-session-${crypto.randomUUID()}-`
const NOW = new Date("2026-08-01T12:00:00.000Z")
const LATER = new Date("2026-08-01T12:30:00.000Z")
const MUCH_LATER = new Date("2026-08-01T14:00:00.000Z")
const FAR = new Date("2026-08-02T12:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
let repository: AdminSessionRepository
const written: string[] = []

function row(suffix: string, overrides: Partial<AdminSessionRow> = {}): AdminSessionRow {
  const idHash = `${PREFIX}${suffix}`
  written.push(idHash)
  return {
    idHash,
    username: "admin@example.test",
    csrfToken: `csrf-${suffix}`,
    createdAt: NOW,
    lastSeenAt: NOW,
    idleExpiryAt: LATER,
    absoluteExpiryAt: FAR,
    ...overrides,
  }
}

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  repository = createAdminSessionRepository(db)
})

afterEach(async () => {
  if (handle === undefined || written.length === 0) return
  await db.delete(adminSessions).where(inArray(adminSessions.idHash, written))
  written.length = 0
})

afterAll(async () => {
  await handle?.close()
})

describe.skipIf(!runnable)("the admin session repository against a live database", () => {
  test("upsert then find round-trips every column", async () => {
    const stored = row("round-trip")
    await repository.create(stored)

    expect(await repository.find(stored.idHash)).toEqual(stored)
    expect(await repository.find(`${PREFIX}never-written`)).toBeUndefined()
  })

  test("an upsert onto an existing row is a slide: only last_seen and idle_expiry move", async () => {
    const original = row("slide")
    await repository.create(original)

    await repository.touch({
      ...original,
      username: "impostor@example.test",
      csrfToken: "rotated",
      createdAt: FAR,
      lastSeenAt: new Date(NOW.getTime() + 60_000),
      idleExpiryAt: MUCH_LATER,
      absoluteExpiryAt: new Date(FAR.getTime() + 86_400_000),
    })

    expect(await repository.find(original.idHash)).toEqual({
      ...original,
      lastSeenAt: new Date(NOW.getTime() + 60_000),
      idleExpiryAt: MUCH_LATER,
    })
  })

  test("delete reports whether a row was there", async () => {
    const stored = row("delete")
    await repository.create(stored)

    expect(await repository.delete(stored.idHash)).toBe(true)
    expect(await repository.delete(stored.idHash)).toBe(false)
    expect(await repository.find(stored.idHash)).toBeUndefined()
  })

  test("deleteExpiredBefore takes rows past either bound, keeps live ones, honours the limit", async () => {
    const idleOut = row("idle-out", { idleExpiryAt: NOW, absoluteExpiryAt: FAR })
    const cappedOut = row("capped-out", { idleExpiryAt: FAR, absoluteExpiryAt: LATER })
    const live = row("live", { idleExpiryAt: FAR, absoluteExpiryAt: FAR })
    for (const r of [idleOut, cappedOut, live]) await repository.create(r)

    // Cutoff equals `idleOut`'s bound exactly: `<=`, so it goes; `cappedOut`'s
    // bound is later and stays. `<` here would leave a session `authenticate()`
    // already refuses sitting in the table until the next tick.
    expect(await repository.deleteExpiredBefore(NOW, 10)).toBe(1)
    expect(await repository.find(idleOut.idHash)).toBeUndefined()
    expect(await repository.find(cappedOut.idHash)).toBeDefined()

    await repository.create(idleOut)
    // Both expired, limit one: soonest-expired first, and the count is the
    // "there is more" signal.
    expect(await repository.deleteExpiredBefore(MUCH_LATER, 1)).toBe(1)
    expect(await repository.find(idleOut.idHash)).toBeUndefined()
    expect(await repository.find(cappedOut.idHash)).toBeDefined()
    expect(await repository.deleteExpiredBefore(MUCH_LATER, 1)).toBe(1)
    expect(await repository.deleteExpiredBefore(MUCH_LATER, 1)).toBe(0)

    expect(await repository.find(live.idHash)).toBeDefined()
  })
})

describe.skipIf(!runnable)("session touch cannot restore revoked authority", () => {
  test("touch of a deleted session cannot recreate it", async () => {
    const stored = row("revoked")
    await repository.create(stored)
    await repository.delete(stored.idHash)
    expect(await repository.touch({ ...stored, lastSeenAt: new Date(NOW.getTime() + 1000) })).toBe(
      false,
    )
    expect(await repository.find(stored.idHash)).toBeUndefined()
  })
  test("touch refuses expired sessions and never moves activity backwards", async () => {
    const stored = row("expired")
    await repository.create(stored)
    expect(await repository.touch({ ...stored, lastSeenAt: LATER, idleExpiryAt: FAR })).toBe(false)
    const recent = { ...stored, lastSeenAt: new Date(NOW.getTime() + 2000), idleExpiryAt: FAR }
    expect(await repository.touch(recent)).toBe(true)
    expect(await repository.touch({ ...stored, lastSeenAt: new Date(NOW.getTime() + 1000) })).toBe(
      true,
    )
    expect(await repository.find(stored.idHash)).toEqual(recent)
  })
})

describe.skipIf(!runnable)("revoking sessions by identity", () => {
  test("deleteByUsername ends every session of that identity and no other", async () => {
    const mine = [
      row("revoke-a", { username: "local-admin-test@example.test" }),
      row("revoke-b", { username: "local-admin-test@example.test" }),
    ]
    const theirs = row("revoke-other", { username: "operator@example.test" })
    for (const r of [...mine, theirs]) await repository.create(r)

    expect(await repository.deleteByUsername("local-admin-test@example.test")).toBe(2)
    for (const r of mine) expect(await repository.find(r.idHash)).toBeUndefined()
    expect(await repository.find(theirs.idHash)).toEqual(theirs)
    expect(await repository.deleteByUsername("local-admin-test@example.test")).toBe(0)
  })

  test("deleteAll ends every session", async () => {
    // Inside a rolled-back transaction: the dev database is shared, and a real delete-all would
    // sign out the operator's own console and any other suite's sessions.
    const rollback = new Error("rollback")
    let deleted = -1
    let left = -1
    const outcome = await db
      .transaction(async (tx) => {
        const scoped = createAdminSessionRepository(tx)
        await scoped.create(row("all-a"))
        await scoped.create(row("all-b", { username: "operator@example.test" }))
        deleted = await scoped.deleteAll()
        const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(adminSessions)
        left = count?.n ?? -1
        throw rollback
      })
      .catch((error: unknown) => error)
    expect(outcome).toBe(rollback)
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(left).toBe(0)
  })
})
