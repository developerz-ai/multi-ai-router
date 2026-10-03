import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"

const url = process.env.DATABASE_URL ?? ""
let handle: DatabaseHandle | undefined
let repo: AccountRepository
const ids: string[] = []
beforeAll(async () => {
  if (!url) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  repo = createAccountRepository(handle.db)
})
afterAll(async () => {
  if (handle && ids.length) await handle.db.delete(accounts).where(inArray(accounts.id, ids))
  await handle?.close()
})
async function seed() {
  const row = await repo.create({ label: "quota-ordering-fixture", provider: "zai" })
  ids.push(row.id)
  return row.id
}
const old = new Date("2020-01-01T00:00:00Z")
const fresh = new Date("2020-01-01T00:00:01Z")
const reset = new Date("2020-01-01T00:01:00Z")
const futureReset = new Date("2090-01-01T00:00:00Z")
function reading(lastCheckedAt: Date, utilization: number, resetsAt: Date) {
  return {
    window: "five_hour" as const,
    utilization,
    utilizationSource: "continuous" as const,
    resetsAt,
    resetSource: "provider-reported" as const,
    lastCheckedAt,
  }
}
describe.skipIf(!url)("quota observations and stale floor CAS", () => {
  test("older observation cannot shorten a new spent window", async () => {
    const id = await seed()
    const current = await repo.upsertQuotaWindow(id, reading(fresh, 1, futureReset))
    const rejected = await repo.upsertQuotaWindow(id, reading(old, 0, reset))
    expect(rejected).toMatchObject({
      utilization: 1,
      resetsAt: futureReset,
      revision: current.revision,
    })
  })
  test("equal timestamp higher utilization wins; lower or unknown can never clear it", async () => {
    const id = await seed()
    await repo.upsertQuotaWindow(id, reading(fresh, 0, reset))
    const spent = await repo.upsertQuotaWindow(id, reading(fresh, 1, futureReset))
    expect(spent).toMatchObject({ utilization: 1, resetsAt: futureReset, revision: 1 })
    const lower = await repo.upsertQuotaWindow(id, reading(fresh, 0, reset))
    const unknown = await repo.upsertQuotaWindow(id, {
      window: "five_hour",
      utilizationSource: "none",
      resetSource: "unknown",
      lastCheckedAt: fresh,
    })
    expect(lower).toMatchObject({ utilization: 1, resetsAt: futureReset, revision: 1 })
    expect(unknown).toMatchObject({
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: futureReset,
      resetSource: "provider-reported",
      revision: 1,
    })
  })
  test("equal unknown utilization accepts known reading and later reset cannot erase it", async () => {
    const id = await seed()
    await repo.upsertQuotaWindow(id, {
      window: "five_hour",
      utilizationSource: "none",
      resetSource: "unknown",
      lastCheckedAt: fresh,
    })
    expect(
      await repo.upsertQuotaWindow(id, {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        resetSource: "unknown",
        lastCheckedAt: fresh,
      }),
    ).toMatchObject({ utilization: 1, resetsAt: null, revision: 1 })
    expect(
      await repo.upsertQuotaWindow(id, {
        window: "five_hour",
        utilizationSource: "none",
        resetsAt: futureReset,
        resetSource: "provider-reported",
        lastCheckedAt: fresh,
      }),
    ).toMatchObject({
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: futureReset,
      resetSource: "provider-reported",
      revision: 2,
    })
  })
  test("equal timestamp later reset extends restriction without lowering utilization", async () => {
    const id = await seed()
    await repo.upsertQuotaWindow(id, reading(fresh, 1, reset))
    expect(await repo.upsertQuotaWindow(id, reading(fresh, 0, futureReset))).toMatchObject({
      utilization: 1,
      resetsAt: futureReset,
      revision: 1,
    })
  })
  test("stale floor selection cannot clear fresh provider evidence", async () => {
    const id = await seed()
    const selected = await repo.upsertQuotaWindow(id, reading(old, 1, reset))
    await repo.upsertQuotaWindow(id, reading(fresh, 1, futureReset))
    expect(
      await repo.clearObservedQuotaWindow({
        accountId: id,
        window: "five_hour",
        expected: { revision: selected.revision, resetsAt: reset },
        now: new Date(),
      }),
    ).toBeUndefined()
    expect((await repo.listQuotaWindows([id]))[0]).toMatchObject({
      utilization: 1,
      resetsAt: futureReset,
      lastCheckedAt: fresh,
      revision: 1,
    })
  })
  test("matching expired window clears to unknown once and preserves provider age", async () => {
    const id = await seed()
    const selected = await repo.upsertQuotaWindow(id, reading(old, 1, reset))
    const input = {
      accountId: id,
      window: "five_hour" as const,
      expected: { revision: selected.revision, resetsAt: reset },
      now: new Date(),
    }
    expect(await repo.clearObservedQuotaWindow(input)).toMatchObject({
      utilization: null,
      utilizationSource: "none",
      resetsAt: null,
      resetSource: "unknown",
      lastCheckedAt: old,
      revision: 1,
    })
    expect(await repo.clearObservedQuotaWindow(input)).toBeUndefined()
  })
  test("a fast host clock cannot retire future provider reset", async () => {
    const id = await seed()
    const selected = await repo.upsertQuotaWindow(id, reading(old, 1, futureReset))
    expect(
      await repo.clearObservedQuotaWindow({
        accountId: id,
        window: "five_hour",
        expected: { revision: selected.revision, resetsAt: futureReset },
        now: new Date("2100-01-01T00:00:00Z"),
      }),
    ).toBeUndefined()
  })
  test("operator exhaustion after floor selection preserves quota evidence", async () => {
    const id = await seed()
    const selected = await repo.upsertQuotaWindow(id, reading(old, 1, reset))
    await repo.updateOperatorAccount({ id, patch: { status: "exhausted" }, now: new Date() })
    expect(
      await repo.clearObservedQuotaWindow({
        accountId: id,
        window: "five_hour",
        expected: { revision: selected.revision, resetsAt: reset },
        now: new Date(),
      }),
    ).toBeUndefined()
    expect((await repo.listQuotaWindows([id]))[0]).toEqual(selected)
  })
  test("expiry tombstone rejects old and equal replay but admits a newer provider observation", async () => {
    const id = await seed()
    const selected = await repo.upsertQuotaWindow(id, reading(fresh, 1, reset))
    const retired = await repo.clearObservedQuotaWindow({
      accountId: id,
      window: "five_hour",
      expected: { revision: selected.revision, resetsAt: reset },
      now: new Date(),
    })
    expect(retired?.retiredAt).toBeInstanceOf(Date)
    expect(await repo.upsertQuotaWindow(id, reading(old, 1, futureReset))).toEqual(retired)
    expect(await repo.upsertQuotaWindow(id, reading(fresh, 1, futureReset))).toEqual(retired)
    expect(
      await repo.upsertQuotaWindow(id, reading(new Date(fresh.getTime() + 1), 0.5, futureReset)),
    ).toMatchObject({ utilization: 0.5, resetsAt: futureReset, retiredAt: null, revision: 2 })
  })
})
