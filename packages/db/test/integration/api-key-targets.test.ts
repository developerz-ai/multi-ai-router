import { describe, expect, test } from "bun:test"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import { createPoolRepository } from "../../src/repositories/pool-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * The verification miss path in one statement: a scoped key's prefix lookup used to be followed
 * by two membership queries. The combined read must return exactly what those three did — the
 * usable rows, each with its pool targets in listed order and its account targets.
 */
const fixture = ownDatabaseFixture("key_targets")
const NOW = new Date("2026-11-10T12:00:00.000Z")

describe.skipIf(ownDatabaseUrl === "")("findUsableWithTargetsByPrefix", () => {
  test("folds pool order and account targets into the prefix read, and hides unusable rows", async () => {
    const db = fixture.db()
    const keys = createApiKeyRepository(db)
    const pools = createPoolRepository(db)
    const accounts = createAccountRepository(db)
    const first = await pools.create({ name: "targets-first" })
    const second = await pools.create({ name: "targets-second" })
    const account = await accounts.create({ label: "targets", provider: "zai", authMaterial: "c" })

    const prefix = "mar_live_targets0"
    const pooled = await keys.create({ name: "pooled", value: "v1", prefix, scope: "pools" })
    // Listed second-then-first: the read must keep the listed order, not the id order.
    await keys.replaceScopeTargets(pooled.id, { poolIds: [second.id, first.id] })
    const direct = await keys.create({ name: "direct", value: "v2", prefix, scope: "accounts" })
    await keys.replaceScopeTargets(direct.id, { accountIds: [account.id] })
    const open = await keys.create({ name: "open", value: "v3", prefix })
    const revoked = await keys.create({ name: "revoked", value: "v4", prefix })
    await keys.markRevoked(revoked.id, NOW)
    await keys.create({ name: "expired", value: "v5", prefix, expiresAt: NOW })

    const rows = await keys.findUsableWithTargetsByPrefix(prefix, NOW)
    const byName = new Map(rows.map((row) => [row.key.name, row]))
    expect([...byName.keys()].sort()).toEqual(["direct", "open", "pooled"])
    expect(byName.get("pooled")?.poolIds).toEqual([second.id, first.id])
    expect(byName.get("pooled")?.accountIds).toEqual([])
    expect(byName.get("direct")?.accountIds).toEqual([account.id])
    expect(byName.get("direct")?.poolIds).toEqual([])
    expect(byName.get("open")).toEqual({ key: open, poolIds: [], accountIds: [] })

    // Same rows as the two-step read it replaces.
    const plain = await keys.findUsableByPrefix(prefix, NOW)
    expect(rows.map((row) => row.key).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      plain.sort((a, b) => a.id.localeCompare(b.id)),
    )
    expect(await keys.findUsableWithTargetsByPrefix("mar_live_nothing0", NOW)).toEqual([])
  })
})

describe.skipIf(ownDatabaseUrl === "")("listSummaries", () => {
  test("is the admin list without the ciphertext, with the same filters and order", async () => {
    const keys = createApiKeyRepository(fixture.db())
    await keys.create({
      name: "summary-a",
      value: "cipher-a",
      prefix: "mar_live_summary0",
      tool: "ci",
    })
    await keys.create({ name: "summary-b", value: "cipher-b", prefix: "mar_live_summary1" })

    const full = await keys.list()
    const summaries = await keys.listSummaries()
    expect(summaries).toEqual(full.map(({ value: _value, ...rest }) => rest))
    for (const row of summaries) expect(Object.keys(row)).not.toContain("value")
    expect((await keys.listSummaries({ tool: "ci" })).map((row) => row.name)).toEqual(["summary-a"])
  })
})
