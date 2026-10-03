import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { defaultMigrationsFolder, runMigrations } from "@multi-ai-router/db"
import { adminMutationDatabase } from "../support/admin-mutation-database"

const url = process.env.DATABASE_URL ?? ""
const fixtures: ReturnType<typeof adminMutationDatabase>[] = []
const missing = "00000000-0000-4000-8000-000000000001"
function fixture(maxConnections = 2) {
  const db = adminMutationDatabase(url, maxConnections)
  fixtures.push(db)
  return db
}
beforeAll(async () => {
  if (url !== "") await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
})
afterEach(async () => {
  for (const db of fixtures.splice(0)) await db.close()
})

describe.skipIf(url === "")("atomic admin mutations against PostgreSQL", () => {
  for (const kind of ["create", "update", "revoke", "remove"] as const) {
    test(`key ${kind} rolls back its complete mutation when the audit fails`, async () => {
      const db = fixture()
      const account = await db.seedAccount()
      const seed = await db.keyService.create({
        name: db.name("before"),
        scope: { kind: "accounts", accountIds: [account.id] },
      })
      if (!seed.ok) throw new Error("seed failed")
      const before = await db.snapshot()
      db.transform((scope) => ({
        ...scope,
        audit: {
          append: async (input) => {
            await scope.audit.append(input)
            throw new Error("audit rollback")
          },
        },
      }))
      const result =
        kind === "create"
          ? db.keyService.create({ name: db.name("after") })
          : kind === "update"
            ? db.keyService.update(seed.value.id, {
                name: db.name("after"),
                scope: { kind: "all" },
              })
            : db.keyService[kind](seed.value.id)
      await expect(result).rejects.toThrow("audit rollback")
      expect(await db.snapshot()).toEqual(before)
      expect(db.committed).toHaveLength(1)
    })
  }

  for (const kind of ["create", "update", "remove"] as const) {
    test(`pool ${kind} rolls back membership and both policy events`, async () => {
      const db = fixture()
      const account = await db.seedAccount()
      const seed = await db.poolService.create({
        name: db.name("before"),
        members: [{ accountId: account.id }],
      })
      if (!seed.ok) throw new Error("seed failed")
      const before = await db.snapshot()
      db.transform((scope) => ({
        ...scope,
        audit: {
          append: async (input) => {
            const row = await scope.audit.append(input)
            if (kind !== "update" || input.kind === "policy.changed")
              throw new Error("audit rollback")
            return row
          },
        },
      }))
      const result =
        kind === "create"
          ? db.poolService.create({ name: db.name("after"), members: [{ accountId: account.id }] })
          : kind === "update"
            ? db.poolService.update(seed.value.id, {
                name: db.name("after"),
                members: [],
                policy: "weighted",
              })
            : db.poolService.remove(seed.value.id)
      await expect(result).rejects.toThrow("audit rollback")
      expect(await db.snapshot()).toEqual(before)
      expect(db.committed).toHaveLength(1)
    })
  }

  test("a failing scope FK rolls back the key row and earlier scope deletes", async () => {
    const db = fixture()
    const account = await db.seedAccount()
    const seed = await db.keyService.create({
      name: db.name("before"),
      scope: { kind: "accounts", accountIds: [account.id] },
    })
    if (!seed.ok) throw new Error("seed failed")
    const before = await db.snapshot()
    db.transform((scope) => ({
      ...scope,
      keys: {
        ...scope.keys,
        replaceScopeTargets: (id, targets) =>
          scope.keys.replaceScopeTargets(id, { ...targets, accountIds: [missing] }),
      },
    }))
    await expect(
      db.keyService.update(seed.value.id, { name: db.name("after"), scope: { kind: "all" } }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { status: 409, code: "reference_deleted" },
    })
    expect(await db.snapshot()).toEqual(before)
    await expect(db.keyService.create({ name: db.name("failed-create") })).resolves.toMatchObject({
      ok: false,
      failure: { status: 409, code: "reference_deleted" },
    })
    expect(await db.snapshot()).toEqual(before)
  })

  test("a failing member FK rolls back pool metadata and earlier membership deletes", async () => {
    const db = fixture()
    const account = await db.seedAccount()
    const seed = await db.poolService.create({
      name: db.name("before"),
      members: [{ accountId: account.id }],
    })
    if (!seed.ok) throw new Error("seed failed")
    const before = await db.snapshot()
    db.transform((scope) => ({
      ...scope,
      pools: {
        ...scope.pools,
        replaceMembers: (id, members) =>
          scope.pools.replaceMembers(id, [...members, { accountId: missing }]),
      },
    }))
    await expect(
      db.poolService.update(seed.value.id, { name: db.name("after"), members: [] }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { status: 409, code: "reference_deleted" },
    })
    expect(await db.snapshot()).toEqual(before)
    await expect(db.poolService.create({ name: db.name("failed-create") })).resolves.toMatchObject({
      ok: false,
      failure: { status: 409, code: "reference_deleted" },
    })
    expect(await db.snapshot()).toEqual(before)
  })

  test("all transactional reads, writes and nested replacements finish with pool size one", async () => {
    const db = fixture(1)
    const account = await db.seedAccount()
    const pool = await db.poolService.create({
      name: db.name("pool"),
      members: [{ accountId: account.id }],
    })
    if (!pool.ok) throw new Error("pool seed failed")
    const key = await db.keyService.create({
      name: db.name("key"),
      scope: { kind: "pools", poolIds: [pool.value.id] },
    })
    if (!key.ok) throw new Error("key seed failed")
    expect((await db.keyService.update(key.value.id, { scope: { kind: "all" } })).ok).toBe(true)
    expect(
      (await db.poolService.update(pool.value.id, { policy: "weighted", members: [] })).ok,
    ).toBe(true)
    expect((await db.keyService.revoke(key.value.id)).ok).toBe(true)
    expect((await db.keyService.remove(key.value.id)).ok).toBe(true)
    expect((await db.poolService.remove(pool.value.id)).ok).toBe(true)
  })
})
