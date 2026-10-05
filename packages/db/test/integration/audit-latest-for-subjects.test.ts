import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AuditRepository,
  createAuditRepository,
} from "../../src/repositories/audit-repository"
import { auditEvents } from "../../src/schema/audit-events"

/**
 * Needs a real PostgreSQL 16+. `latestForSubjects` is the one-query read behind a subscription's
 * estimated login lifetime: newest matching event per subject, observer events (`detail.source`)
 * excluded. A grouped `max` and a `jsonb_exists` predicate are exactly what a unit test cannot bind.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

let handle: DatabaseHandle | undefined
let db: Database
let audit: AuditRepository
const subjects = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  audit = createAuditRepository(db)
})

afterAll(async () => {
  if (handle !== undefined) {
    await db.delete(auditEvents).where(inArray(auditEvents.subjectId, subjects))
  }
  await handle?.close()
})

async function event(subjectId: string, kind: string, at: string, detail: Record<string, unknown>) {
  await db
    .insert(auditEvents)
    .values({ kind, subjectType: "account", subjectId, detail, createdAt: new Date(at) })
}

describe.skipIf(!runnable)("audit latestForSubjects against a live database", () => {
  test("newest interactive login per subject, observer events and other kinds excluded", async () => {
    const [a, b, c] = subjects as [string, string, string]
    await event(a, "account.connected", "2026-09-01T00:00:00Z", { label: "a" })
    await event(a, "account.reauthorized", "2026-09-07T10:00:00Z", { label: "a" })
    // The auth probe's observation of the same kind, later — must not move the login.
    await event(a, "account.reauthorized", "2026-09-20T00:00:00Z", {
      source: "claude_auth_status",
    })
    await event(a, "account.tested", "2026-10-01T00:00:00Z", { outcome: "ok" })
    await event(b, "account.connected", "2026-08-15T00:00:00Z", { label: "b" })
    await event(c, "account.updated", "2026-09-30T00:00:00Z", { label: "c" })

    const rows = await audit.latestForSubjects({
      kinds: ["account.connected", "account.reauthorized"],
      subjectIds: subjects,
      excludeDetailKey: "source",
    })
    const byId = new Map(rows.map((row) => [row.subjectId, row.createdAt]))

    expect(byId.get(a)).toEqual(new Date("2026-09-07T10:00:00Z"))
    expect(byId.get(b)).toEqual(new Date("2026-08-15T00:00:00Z"))
    expect(byId.has(c)).toBe(false)
  })

  test("empty inputs answer empty without a query", async () => {
    expect(await audit.latestForSubjects({ kinds: [], subjectIds: subjects })).toEqual([])
    expect(await audit.latestForSubjects({ kinds: ["x"], subjectIds: [] })).toEqual([])
  })
})
