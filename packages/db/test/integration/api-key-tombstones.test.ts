import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import { createApiKeyTombstoneRepository } from "../../src/repositories/api-key-tombstone-repository"
import { apiKeys } from "../../src/schema/api-keys"
import { historyUrl, usageHistoryFixture } from "./usage-history-fixture"

/**
 * A purged key keeps its attribution (not its secret) so usage rollups that outlive it still name
 * who spent the money. Real Postgres: the purge is one data-modifying CTE and only the planner can
 * say whether the delete and the tombstone insert are the same statement.
 */
const fixture = usageHistoryFixture()

const REVOKED_AT = new Date("1999-01-01T00:00:00.000Z")
const CUTOFF = new Date("2000-01-01T00:00:00.000Z")
const PURGED_AT = new Date("2031-05-06T07:08:09.000Z")

async function revokedKey(name: string, revokedAt: Date, extra: { owner?: string; tool?: string }) {
  const repo = createApiKeyRepository(fixture.db())
  const row = await repo.create({
    name,
    value: "ciphertext-envelope",
    prefix: `mar_live_${name.slice(0, 4)}`,
    owner: extra.owner ?? null,
    ownerKind: extra.owner === undefined ? null : "person",
    tool: extra.tool ?? null,
  })
  await repo.markRevoked(row.id, revokedAt)
  return row
}

describe.skipIf(!historyUrl)("api key tombstones against a live database", () => {
  test("the table has exactly the attribution columns and no value or ciphertext", async () => {
    const rows = await fixture
      .get()
      .sql.unsafe(
        "select column_name from information_schema.columns where table_name = 'api_key_tombstones' order by column_name",
      )
    expect(rows.map((row) => row.column_name)).toEqual([
      "id",
      "name",
      "owner",
      "owner_kind",
      "prefix",
      "purged_at",
      "tool",
    ])
  })

  test("purging deletes the key and writes its tombstone in one statement, at the injected clock", async () => {
    const swept = await revokedKey("sweptkey", REVOKED_AT, { owner: "alice", tool: "editor" })
    const live = await createApiKeyRepository(fixture.db()).create({
      name: "livekey",
      value: "envelope",
      prefix: "mar_live_live",
    })
    const tombstones = createApiKeyTombstoneRepository(fixture.db())

    expect(await tombstones.purgeRevoked(CUTOFF, PURGED_AT, 100)).toBe(1)
    expect(await tombstones.purgeRevoked(CUTOFF, PURGED_AT, 100)).toBe(0)

    expect(await createApiKeyRepository(fixture.db()).findById(swept.id)).toBeUndefined()
    expect(await createApiKeyRepository(fixture.db()).findById(live.id)).toBeDefined()
    const found = (await tombstones.listAll()).find((row) => row.id === swept.id)
    expect(found).toEqual({
      id: swept.id,
      name: "sweptkey",
      prefix: "mar_live_swep",
      owner: "alice",
      ownerKind: "person",
      tool: "editor",
      purgedAt: PURGED_AT,
    })
    expect((await tombstones.listAll()).some((row) => row.id === live.id)).toBe(false)
  })

  test("a purge batch is bounded and oldest revocation first", async () => {
    const older = await revokedKey("olderkey", new Date("1998-01-01T00:00:00.000Z"), {})
    const newer = await revokedKey("newerkey", new Date("1998-06-01T00:00:00.000Z"), {})
    const tombstones = createApiKeyTombstoneRepository(fixture.db())
    expect(await tombstones.purgeRevoked(CUTOFF, PURGED_AT, 1)).toBe(1)
    const ids = (await tombstones.listAll()).map((row) => row.id)
    expect(ids).toContain(older.id)
    expect(ids).not.toContain(newer.id)
    expect(await tombstones.purgeRevoked(CUTOFF, PURGED_AT, 1)).toBe(1)
    expect((await tombstones.listAll()).map((row) => row.id)).toContain(newer.id)
  })

  test("recording an existing tombstone again is a no-op, not a primary-key collision", async () => {
    const key = await revokedKey("twicekey", REVOKED_AT, { owner: "bob" })
    const tombstones = createApiKeyTombstoneRepository(fixture.db())
    await tombstones.record(key, PURGED_AT)
    await tombstones.record(key, new Date("2040-01-01T00:00:00.000Z"))
    const rows = (await tombstones.listAll()).filter((row) => row.id === key.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.purgedAt).toEqual(PURGED_AT)
    // record() never deletes the key: that is the caller's statement, in the same transaction.
    expect(await fixture.db().select().from(apiKeys).where(eq(apiKeys.id, key.id))).toHaveLength(1)
  })

  test("tombstones are swept by purged_at only: young survive, old go, bounded", async () => {
    const tombstones = createApiKeyTombstoneRepository(fixture.db())
    const young = await revokedKey("youngone", REVOKED_AT, {})
    const old = await revokedKey("oldoneey", REVOKED_AT, {})
    await tombstones.record(young, new Date("2030-01-01T00:00:00.000Z"))
    await tombstones.record(old, new Date("2001-01-01T00:00:00.000Z"))
    const horizon = new Date("2020-01-01T00:00:00.000Z")
    expect(await tombstones.deleteOlderThan(horizon, 100)).toBe(1)
    const ids = (await tombstones.listAll()).map((row) => row.id)
    expect(ids).toContain(young.id)
    expect(ids).not.toContain(old.id)
    expect(await tombstones.deleteOlderThan(horizon, 100)).toBe(0)
  })
})
