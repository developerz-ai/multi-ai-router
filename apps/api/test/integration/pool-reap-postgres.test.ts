import { describe, expect, test } from "bun:test"
import {
  createAccountRepository,
  createAdminMutationRepository,
  createApiKeyRepository,
  createPoolRepository,
} from "@multi-ai-router/db"
import {
  ownDatabaseFixture,
  ownDatabaseUrl,
} from "../../../../packages/db/test/integration/own-database-fixture"
import { createPoolReaper } from "../../src/services/pools"

/**
 * The empty-pool reap end to end against Postgres: the trigger starts the clock when an account
 * deletion cascades away a pool's last member, and the reap's own delete cascades the key bindings,
 * so a key that named another pool keeps exactly that one.
 */
const fixture = ownDatabaseFixture("pool_reap_api")
const FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z")
const NOW = new Date("2026-11-18T00:00:00.000Z")

describe.skipIf(ownDatabaseUrl === "")("empty-pool reap on Postgres", () => {
  test("an account deletion empties the pool; the reap deletes it and settles its keys", async () => {
    const db = fixture.db()
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const keys = createApiKeyRepository(db)
    const doomed = await pools.create({ name: "reap-pg-doomed" })
    const kept = await pools.create({ name: "reap-pg-kept" })
    const account = await accounts.create({ label: "reap-pg", provider: "zai", authMaterial: "c" })
    const stays = await accounts.create({ label: "reap-pg-2", provider: "zai", authMaterial: "c" })
    await pools.replaceMembers(doomed.id, [{ accountId: account.id }])
    await pools.replaceMembers(kept.id, [{ accountId: stays.id }])
    const sole = await keys.create({
      name: "reap-pg-sole",
      value: "v",
      prefix: "mar_live_rpg000",
      scope: "pools",
    })
    const shared = await keys.create({
      name: "reap-pg-shared",
      value: "v",
      prefix: "mar_live_rpg001",
      scope: "pools",
    })
    await keys.replaceScopeTargets(sole.id, { poolIds: [doomed.id] })
    await keys.replaceScopeTargets(shared.id, { poolIds: [doomed.id, kept.id] })

    const reaper = createPoolReaper({
      mutations: createAdminMutationRepository(db),
      now: () => NOW,
      coherence: { refreshCatalog: async () => {}, forgetKey: () => {}, invalidateKey: () => {} },
    })
    // Still a member: the reap refuses whatever the cutoff.
    expect((await reaper.reap(doomed.id, FAR_FUTURE)).kind).toBe("skipped")

    await accounts.delete(account.id)
    expect((await pools.listEmptySince(FAR_FUTURE, 1_000)).map((pool) => pool.id)).toContain(
      doomed.id,
    )

    const outcome = await reaper.reap(doomed.id, FAR_FUTURE)

    expect(outcome).toMatchObject({
      kind: "reaped",
      poolId: doomed.id,
      revokedKeyIds: [sole.id],
      detachedKeyIds: [shared.id],
    })
    expect(await pools.findById(doomed.id)).toBeUndefined()
    expect((await keys.findById(sole.id))?.revoked).toBe(true)
    expect((await keys.findById(shared.id))?.revoked).toBe(false)
    expect((await keys.listPoolTargets(shared.id)).map((row) => row.poolId)).toEqual([kept.id])
  })
})
