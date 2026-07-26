import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"

/**
 * Needs a real PostgreSQL 16+.
 *
 * `updateStatusWhen` is the router's own verdict about an upstream written to the same column an
 * operator sets by hand, so its whole value is the predicate: `disabled` is the operator's word and
 * must survive an observation, and a standing block must not be rewritten by a second one. A unit
 * test can lock the SQL that predicate compiles to; only a live planner answers whether comparing a
 * text parameter against an `account_status` enum column narrows anything at all — a cast postgres
 * silently resolves the wrong way would make the guard match nothing, or everything.
 *
 * It never talks to a provider, only to the database, and removes every row it wrote.
 */
// `DATABASE_URL` and nothing else: `bin/check` refuses to run without one and `bin/test` names this
// file when it skips, so the skip can no longer be silent.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const NOW = new Date("2026-07-24T12:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
let repository: AccountRepository

const accountIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  repository = createAccountRepository(db)
})

afterAll(async () => {
  if (handle !== undefined && accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, accountIds))
  }
  await handle?.close()
})

/** One account in a known status. Its id is registered for teardown. */
async function seed(status: "active" | "cooling_down" | "disabled" | "needs_reauth" | "exhausted") {
  const row = await repository.create({
    label: `test-status-${accountIds.length}-${status}`,
    provider: "zai",
    status,
  })
  accountIds.push(row.id)
  return row
}

const OBSERVABLE = ["active", "cooling_down"] as const

describe.skipIf(!runnable)("the observed-status guard against a live database", () => {
  test("applies to a row inside the guard, and reports the row it changed", async () => {
    const row = await seed("active")
    const written = await repository.updateStatusWhen(row.id, OBSERVABLE, "exhausted", NOW)

    expect(written?.status).toBe("exhausted")
    expect(written?.updatedAt).toEqual(NOW)
    expect((await repository.findById(row.id))?.status).toBe("exhausted")
  })

  test("a cooling_down row is fair game — a clock was going to end it anyway", async () => {
    const row = await seed("cooling_down")
    const written = await repository.updateStatusWhen(row.id, OBSERVABLE, "needs_reauth", NOW)

    expect(written?.status).toBe("needs_reauth")
  })

  test("never overwrites the operator's disabled, and says so by changing nothing", async () => {
    const row = await seed("disabled")
    const written = await repository.updateStatusWhen(row.id, OBSERVABLE, "exhausted", NOW)

    expect(written).toBeUndefined()
    expect((await repository.findById(row.id))?.status).toBe("disabled")
  })

  test("never rewrites one standing block as another", async () => {
    // The remedy on the operator's screen must not change while they are carrying it out.
    const row = await seed("needs_reauth")
    const written = await repository.updateStatusWhen(row.id, OBSERVABLE, "exhausted", NOW)

    expect(written).toBeUndefined()
    expect((await repository.findById(row.id))?.status).toBe("needs_reauth")
  })

  test("clearing an exhausted is the same statement, guarded the other way", async () => {
    // What "Re-check now" issues. It may lift the block the router formed, and nothing else.
    const exhausted = await seed("exhausted")
    const disabled = await seed("disabled")

    expect(
      (await repository.updateStatusWhen(exhausted.id, ["exhausted"], "active", NOW))?.status,
    ).toBe("active")
    expect(
      await repository.updateStatusWhen(disabled.id, ["exhausted"], "active", NOW),
    ).toBeUndefined()
    expect((await repository.findById(disabled.id))?.status).toBe("disabled")
  })

  test("an unknown id changes nothing rather than erroring", async () => {
    const missing = "00000000-0000-0000-0000-0000000000ff"
    expect(await repository.updateStatusWhen(missing, OBSERVABLE, "exhausted", NOW)).toBeUndefined()
  })

  test("an empty guard admits nothing", async () => {
    const row = await seed("active")
    expect(await repository.updateStatusWhen(row.id, [], "exhausted", NOW)).toBeUndefined()
    expect((await repository.findById(row.id))?.status).toBe("active")
  })
})
