import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  createCatalogSnapshotRepository,
  type Database,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { adminMutationDatabase, deferred } from "../support/admin-mutation-database"

const url = process.env.DATABASE_URL ?? ""
const fixtures: ReturnType<typeof adminMutationDatabase>[] = []
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

describe.skipIf(url === "")("serialized admin mutations against PostgreSQL", () => {
  test("a catalog read stays on one snapshot while another connection commits new membership", async () => {
    const db = fixture(1)
    const writer = fixture(1)
    const before = await db.seedAccount()
    const after = await db.seedAccount()
    const pool = await db.poolService.create({
      name: db.name("snapshot"),
      members: [{ accountId: before.id }],
    })
    if (!pool.ok) throw new Error("seed failed")
    const transaction: Database["transaction"] = (work, config) =>
      db.handle.db.transaction(async (tx) => {
        // Establish the transaction snapshot, then let a different replica commit. Every real
        // catalog query must remain in this transaction, even with just one pooled connection.
        await tx.execute("select id from pools limit 1")
        const updated = await writer.poolService.update(pool.value.id, {
          policy: "weighted",
          members: [{ accountId: after.id }],
        })
        if (!updated.ok) throw new Error("concurrent mutation failed")
        return work(tx)
      }, config)
    const intercepted = new Proxy(db.handle.db, {
      get: (target, property, receiver) =>
        property === "transaction" ? transaction : Reflect.get(target, property, receiver),
    })
    const snapshot = await createCatalogSnapshotRepository(intercepted).read()
    expect(snapshot.pools.find((row) => row.id === pool.value.id)?.policy).toBe("sticky")
    expect(
      snapshot.members.filter((row) => row.poolId === pool.value.id).map((row) => row.accountId),
    ).toEqual([before.id])
    const fresh = await createCatalogSnapshotRepository(db.handle.db).read()
    expect(fresh.pools.find((row) => row.id === pool.value.id)?.policy).toBe("weighted")
    expect(
      fresh.members.filter((row) => row.poolId === pool.value.id).map((row) => row.accountId),
    ).toEqual([after.id])
  })

  for (const entity of ["key", "pool"] as const) {
    for (const operation of ["create", "rename"] as const) {
      test(`concurrent ${entity} ${operation}s have one name winner and one conflict`, async () => {
        const db = fixture()
        const service = entity === "key" ? db.keyService : db.poolService
        const first = await service.create({ name: db.name("first") })
        const second = await service.create({ name: db.name("second") })
        if (!first.ok || !second.ok) throw new Error("seed failed")
        // Delay after the duplicate check. Without the advisory name lock both transactions
        // observe no row before either insert/update, deterministically opening the name race.
        db.transform((scope) => ({
          ...scope,
          keys: {
            ...scope.keys,
            findByName: async (name) => {
              const found = await scope.keys.findByName(name)
              await Bun.sleep(25)
              return found
            },
          },
          pools: {
            ...scope.pools,
            findByName: async (name) => {
              const found = await scope.pools.findByName(name)
              await Bun.sleep(25)
              return found
            },
          },
        }))
        const name = db.name("shared")
        const results =
          operation === "create"
            ? await Promise.all([service.create({ name }), service.create({ name })])
            : await Promise.all([
                service.update(first.value.id, { name }),
                service.update(second.value.id, { name }),
              ])
        expect(results.filter((result) => result.ok)).toHaveLength(1)
        expect(results.find((result) => !result.ok)).toMatchObject({
          ok: false,
          failure: { status: 409 },
        })
        const rows = entity === "key" ? await db.keys.list() : await db.pools.list()
        expect(rows.filter((row) => row.name === name)).toHaveLength(1)
      })
    }
  }

  test("a concurrent membership edit validates against the committed overflow", async () => {
    const db = fixture()
    const firstAccount = await db.seedAccount()
    const overflow = await db.seedAccount()
    const pool = await db.poolService.create({
      name: db.name("team"),
      members: [{ accountId: firstAccount.id }, { accountId: overflow.id }],
    })
    if (!pool.ok) throw new Error("seed failed")
    const entered = deferred()
    const proceed = deferred()
    let firstRead = true
    db.transform((scope) => ({
      ...scope,
      pools: {
        ...scope.pools,
        findById: async (id) => {
          const row = await scope.pools.findById(id)
          if (firstRead) {
            firstRead = false
            entered.release()
            await proceed.promise
          }
          return row
        },
      },
    }))
    const settingOverflow = db.poolService.update(pool.value.id, { overflowAccountId: overflow.id })
    await entered.promise
    const removingMember = db.poolService.update(pool.value.id, {
      members: [{ accountId: firstAccount.id }],
    })
    await Bun.sleep(25)
    proceed.release()
    expect((await settingOverflow).ok).toBe(true)
    expect(await removingMember).toMatchObject({
      ok: false,
      failure: { code: "overflow_not_member" },
    })
    expect((await db.pools.findById(pool.value.id))?.overflowAccountId).toBe(overflow.id)
    expect((await db.pools.listMembers(pool.value.id)).map((row) => row.accountId)).toContain(
      overflow.id,
    )
  })

  test("pool deletion waits for a pending scope insert, then reports the referencing key", async () => {
    const db = fixture()
    const pool = await db.poolService.create({ name: db.name("team") })
    if (!pool.ok) throw new Error("seed failed")
    const inserted = deferred()
    const commit = deferred()
    db.transform((scope) => ({
      ...scope,
      keys: {
        ...scope.keys,
        replaceScopeTargets: async (id, targets) => {
          await scope.keys.replaceScopeTargets(id, targets)
          inserted.release()
          await commit.promise
        },
      },
    }))
    const creating = db.keyService.create({
      name: db.name("scoped"),
      scope: { kind: "pools", poolIds: [pool.value.id] },
    })
    await inserted.promise
    let deletionFinished = false
    const deleting = db.poolService.remove(pool.value.id).finally(() => {
      deletionFinished = true
    })
    await Bun.sleep(25)
    expect(deletionFinished).toBe(false)
    commit.release()
    const key = await creating
    expect(key.ok).toBe(true)
    expect(await deleting).toMatchObject({ ok: false, failure: { code: "pool_in_use" } })
    expect(await db.pools.findById(pool.value.id)).toBeDefined()
    if (key.ok) expect(await db.keys.listPoolTargets(key.value.id)).toHaveLength(1)
  })

  test("a pending pool deletion makes a later scope insert fail atomically", async () => {
    const db = fixture()
    const pool = await db.poolService.create({ name: db.name("team") })
    if (!pool.ok) throw new Error("seed failed")
    const checked = deferred()
    const inserting = deferred()
    const proceed = deferred()
    db.transform((scope) => ({
      ...scope,
      keys: {
        ...scope.keys,
        replaceScopeTargets: async (id, targets) => {
          inserting.release()
          return scope.keys.replaceScopeTargets(id, targets)
        },
        listKeysScopedToPool: async (id) => {
          const keys = await scope.keys.listKeysScopedToPool(id)
          checked.release()
          await proceed.promise
          return keys
        },
      },
    }))
    const deleting = db.poolService.remove(pool.value.id)
    await checked.promise
    const creating = db.keyService.create({
      name: db.name("too-late"),
      scope: { kind: "pools", poolIds: [pool.value.id] },
    })
    await inserting.promise
    proceed.release()
    expect((await deleting).ok).toBe(true)
    const result = await creating
    expect(result).toMatchObject({
      ok: false,
      failure: { status: 409, code: "reference_deleted" },
    })
    expect(await db.keys.findByName(db.name("too-late"))).toBeUndefined()
  })
  test("a PostgreSQL deadlock retries the entire mutation after rollback", async () => {
    const db = fixture()
    const first = await db.poolService.create({ name: db.name("lock-first") })
    const second = await db.poolService.create({ name: db.name("lock-second") })
    if (!first.ok || !second.ok) throw new Error("seed failed")
    const bothLocked = deferred()
    let attempts = 0
    const edit = (id: string, other: string) =>
      db.repository.run({ kind: "pool", id }, async (scope) => {
        attempts++
        // The runner holds this pool; first attempts now request the other in reverse order.
        if (attempts === 2) bothLocked.release()
        await bothLocked.promise
        await scope.pools.update(other, { policy: "weighted" }, new Date())
        return "committed"
      })
    expect(
      await Promise.all([
        edit(first.value.id, second.value.id),
        edit(second.value.id, first.value.id),
      ]),
    ).toEqual(["committed", "committed"])
    expect(attempts).toBe(3)
    expect((await db.pools.findById(first.value.id))?.policy).toBe("weighted")
    expect((await db.pools.findById(second.value.id))?.policy).toBe("weighted")
  })
  test("overflow-account deletion and membership edits recover whichever transaction loses", async () => {
    const db = fixture()
    const account = await db.seedAccount()
    const pool = await db.poolService.create({
      name: db.name("overflow-delete"),
      members: [{ accountId: account.id }],
      overflowAccountId: account.id,
    })
    if (!pool.ok) throw new Error("seed failed")
    let deleting: Promise<boolean> | undefined
    db.transform((scope) => ({
      ...scope,
      pools: {
        ...scope.pools,
        listMembers: async (id) => {
          const members = await scope.pools.listMembers(id)
          if (deleting === undefined) {
            // The mutation holds the pool. Deletion locks its account before its SET NULL
            // cascade waits here; replacing members then requests that locked account.
            deleting = db.accounts.delete(account.id)
            await Bun.sleep(50)
          }
          return members
        },
      },
    }))
    const edited = await db.poolService.update(pool.value.id, {
      members: [{ accountId: account.id }],
    })
    if (deleting === undefined) throw new Error("delete never started")
    expect(await deleting).toBe(true)
    expect(edited.ok || edited.failure.status === 400 || edited.failure.status === 409).toBe(true)
    expect(await db.accounts.findById(account.id)).toBeUndefined()
    expect((await db.pools.findById(pool.value.id))?.overflowAccountId).toBeNull()
  })
})
