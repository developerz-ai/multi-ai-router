import { describe, expect, test } from "bun:test"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import { createPoolRepository } from "../../src/repositories/pool-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * `pools.empty_since` is the durable fact the empty-pool reaper reads, kept by a trigger on
 * `pool_members` (migration 0047). The case a service-side write would miss is the cascade: an
 * account deleted out from under its pools empties them with no pools write at all.
 */
const fixture = ownDatabaseFixture("pool_empty_since")
const FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z")
const FAR_PAST = new Date("2000-01-01T00:00:00.000Z")

describe.skipIf(ownDatabaseUrl === "")("pools.empty_since", () => {
  test("a pool created with no member is empty from creation; a member clears it", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const pool = await pools.create({ name: "empty-since-create" })
    expect(pool.emptySince).toBeInstanceOf(Date)

    const account = await accounts.create({ label: "es-a", provider: "zai", authMaterial: "c" })
    await pools.replaceMembers(pool.id, [{ accountId: account.id }])
    expect((await pools.findById(pool.id))?.emptySince).toBeNull()
  })

  test("replacing members with a non-empty set keeps it clear; emptying it marks it", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const pool = await pools.create({ name: "empty-since-replace" })
    const one = await accounts.create({ label: "es-b1", provider: "zai", authMaterial: "c" })
    const two = await accounts.create({ label: "es-b2", provider: "zai", authMaterial: "c" })
    await pools.replaceMembers(pool.id, [{ accountId: one.id }, { accountId: two.id }])
    // Delete-then-insert in one transaction: the intermediate empty state must not stick.
    await pools.replaceMembers(pool.id, [{ accountId: two.id }])
    expect((await pools.findById(pool.id))?.emptySince).toBeNull()

    await pools.replaceMembers(pool.id, [])
    expect((await pools.findById(pool.id))?.emptySince).toBeInstanceOf(Date)
  })

  test("an account deletion that cascades away the last member marks the pool", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const pool = await pools.create({ name: "empty-since-cascade" })
    const kept = await pools.create({ name: "empty-since-cascade-kept" })
    const gone = await accounts.create({ label: "es-c1", provider: "zai", authMaterial: "c" })
    const stays = await accounts.create({ label: "es-c2", provider: "zai", authMaterial: "c" })
    await pools.replaceMembers(pool.id, [{ accountId: gone.id }])
    await pools.replaceMembers(kept.id, [{ accountId: gone.id }, { accountId: stays.id }])

    await accounts.delete(gone.id)

    expect((await pools.findById(pool.id))?.emptySince).toBeInstanceOf(Date)
    // A pool that still holds a member is not empty because one of its members went.
    expect((await pools.findById(kept.id))?.emptySince).toBeNull()
  })

  test("listEmptySince returns only memberless pools at or before the cutoff", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const empty = await pools.create({ name: "empty-since-list-empty" })
    const full = await pools.create({ name: "empty-since-list-full" })
    const account = await accounts.create({ label: "es-d", provider: "zai", authMaterial: "c" })
    await pools.replaceMembers(full.id, [{ accountId: account.id }])

    const due = (await pools.listEmptySince(FAR_FUTURE, 1_000)).map((pool) => pool.id)
    expect(due).toContain(empty.id)
    expect(due).not.toContain(full.id)
    expect((await pools.listEmptySince(FAR_PAST, 1_000)).map((pool) => pool.id)).not.toContain(
      empty.id,
    )
    expect(await pools.listEmptySince(FAR_FUTURE, 1)).toHaveLength(1)
  })
})

describe.skipIf(ownDatabaseUrl === "")("lockKeysScopedToPool", () => {
  test("is the keys naming the pool, in id order", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const keys = createApiKeyRepository(db)
    const pool = await pools.create({ name: "lock-keys-pool" })
    const other = await pools.create({ name: "lock-keys-other" })
    const a = await keys.create({
      name: "lock-a",
      value: "v",
      prefix: "mar_live_lock000",
      scope: "pools",
    })
    const b = await keys.create({
      name: "lock-b",
      value: "v",
      prefix: "mar_live_lock001",
      scope: "pools",
    })
    const c = await keys.create({
      name: "lock-c",
      value: "v",
      prefix: "mar_live_lock002",
      scope: "pools",
    })
    await keys.replaceScopeTargets(a.id, { poolIds: [pool.id] })
    await keys.replaceScopeTargets(b.id, { poolIds: [other.id, pool.id] })
    await keys.replaceScopeTargets(c.id, { poolIds: [other.id] })

    const locked = await db.transaction((tx) =>
      createApiKeyRepository(tx).lockKeysScopedToPool(pool.id),
    )
    expect(locked.map((key) => key.id)).toEqual([a.id, b.id].sort())
  })
})

describe.skipIf(ownDatabaseUrl === "")("pools.empty_since under concurrent deletions", () => {
  test("two transactions deleting the last two members still mark the pool", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const pool = await pools.create({ name: "empty-since-race" })
    const one = await accounts.create({ label: "es-r1", provider: "zai", authMaterial: "c" })
    const two = await accounts.create({ label: "es-r2", provider: "zai", authMaterial: "c" })
    await pools.replaceMembers(pool.id, [{ accountId: one.id }, { accountId: two.id }])

    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstDeleted = () => {}
    const deleted = new Promise<void>((resolve) => {
      firstDeleted = resolve
    })
    // The first deletion stays open while the second runs, so neither sees the other committed.
    const first = db.transaction(async (tx) => {
      await createAccountRepository(tx).delete(one.id)
      firstDeleted()
      await held
    })
    await deleted
    const second = db.transaction((tx) => createAccountRepository(tx).delete(two.id))
    setTimeout(release, 200)
    await Promise.all([first, second])

    expect((await pools.findById(pool.id))?.emptySince).toBeInstanceOf(Date)
  })
})
