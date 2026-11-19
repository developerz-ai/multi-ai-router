import { describe, expect, test } from "bun:test"
import { createPoolReaper, createPoolsService } from "../../../src/services/pools"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"

/**
 * multi-ai-router#454: a pool's audit row says WHICH members and keys a change touched, not just
 * how many. On 2026-11-18 `pool.updated` recorded `memberCount: 0` and nothing else, so nobody could
 * read from the router's own history which account had been removed.
 *
 * Entries are `{ accountId, name }` (`name` is the account's label) and `{ keyId, name }`, never a
 * credential or key value. Lists are compared sorted: the order they are written in is the
 * repository's, which differs between Postgres and the memory store.
 */

const NOW = new Date("2026-08-10T00:00:00.000Z")
const DAY_MS = 24 * 60 * 60_000

type Named = Record<string, unknown> & { readonly name: string | null }
const sorted = (rows: unknown): Named[] =>
  [...((rows ?? []) as Named[])].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  )

async function harness() {
  const store = createMemoryStore()
  const service = createPoolsService({
    logger: silentLogger(),
    mutations: store.mutations,
    onCommitted: () => {},
    pools: store.pools,
    accounts: store.accounts,
    now: () => NOW,
  })
  const din = await store.accounts.create({ label: "din-claude", provider: "zai" })
  const seb = await store.accounts.create({ label: "seb-claude", provider: "zai" })
  const ivan = await store.accounts.create({ label: "ivan-claude", provider: "zai" })
  const detail = (kind: string) => store.rows.audit.findLast((row) => row.kind === kind)?.detail
  return { store, service, din, seb, ivan, detail }
}

describe("pool.updated names the members a membership edit added and removed", () => {
  test("removing one member and adding another records both lists", async () => {
    const { service, din, seb, ivan, detail } = await harness()
    const pool = await service.create({
      name: "reviewers",
      members: [{ accountId: din.id }, { accountId: seb.id }],
    })
    if (!pool.ok) throw new Error("setup failed")

    const updated = await service.update(pool.value.id, {
      members: [{ accountId: seb.id }, { accountId: ivan.id }],
    })

    expect(updated.ok).toBe(true)
    expect(detail("pool.updated")).toMatchObject({
      memberCount: 2,
      membersAdded: [{ accountId: ivan.id, name: "ivan-claude" }],
      membersRemoved: [{ accountId: din.id, name: "din-claude" }],
    })
  })

  test("emptying a pool lists every member it lost — the 2026-11-18 row that said only 0", async () => {
    const { service, din, seb, detail } = await harness()
    const pool = await service.create({
      name: "reviewers",
      members: [{ accountId: din.id }, { accountId: seb.id }],
    })
    if (!pool.ok) throw new Error("setup failed")

    await service.update(pool.value.id, { members: [] })

    const row = detail("pool.updated")
    expect(row).toMatchObject({ memberCount: 0, membersAdded: [] })
    expect(sorted(row?.membersRemoved)).toEqual([
      { accountId: din.id, name: "din-claude" },
      { accountId: seb.id, name: "seb-claude" },
    ])
  })

  test("an edit that does not send members records no member lists at all", async () => {
    const { service, din, detail } = await harness()
    const pool = await service.create({ name: "reviewers", members: [{ accountId: din.id }] })
    if (!pool.ok) throw new Error("setup failed")

    await service.update(pool.value.id, { name: "reviewers-eu" })

    const row = detail("pool.updated")
    expect(row).not.toHaveProperty("membersAdded")
    expect(row).not.toHaveProperty("membersRemoved")
    expect(row).not.toHaveProperty("memberCount")
  })
})

describe("pool.created and pool.deleted name the members", () => {
  test("a create lists its initial members", async () => {
    const { service, din, seb, detail } = await harness()
    await service.create({
      name: "reviewers",
      members: [{ accountId: din.id }, { accountId: seb.id }],
    })

    const row = detail("pool.created")
    expect(row).toMatchObject({ memberCount: 2 })
    expect(sorted(row?.members)).toEqual([
      { accountId: din.id, name: "din-claude" },
      { accountId: seb.id, name: "seb-claude" },
    ])
  })

  test("a delete of a pool with members lists the members it had, and the keys it touched", async () => {
    const { store, service, din, seb, detail } = await harness()
    const pool = await service.create({
      name: "reviewers",
      members: [{ accountId: din.id }, { accountId: seb.id }],
    })
    if (!pool.ok) throw new Error("setup failed")

    expect((await service.remove(pool.value.id)).ok).toBe(true)

    const row = detail("pool.deleted")
    expect(sorted(row?.members)).toEqual([
      { accountId: din.id, name: "din-claude" },
      { accountId: seb.id, name: "seb-claude" },
    ])
    // The operator's delete refuses while any key's scope names the pool, so the keys it touched
    // are always none — written anyway, so both deletes carry the same fields.
    expect(row).toMatchObject({ keys: [] })
    expect(store.rows.pools).toHaveLength(0)
  })
})

describe("the reaper's pool.deleted names the keys it touched", () => {
  test("lists each key with what the reap did to it, and the (empty) membership it had", async () => {
    const store = createMemoryStore()
    const reaper = createPoolReaper({
      logger: silentLogger(),
      mutations: store.mutations,
      now: () => NOW,
      coherence: { refreshCatalog: async () => {}, forgetKey: () => {}, invalidateKey: () => {} },
    })
    const stale = await store.pools.create({ name: "opencode-go" })
    const other = await store.pools.create({ name: "other" })
    const held = store.rows.pools.find((row) => row.id === stale.id)
    if (held === undefined) throw new Error("pool not stored")
    held.emptySince = new Date(NOW.getTime() - 8 * DAY_MS)
    const key = async (name: string, poolIds: string[]) => {
      const row = await store.keys.create({
        name,
        value: "v1.k1.cipher",
        prefix: `mar_live_${name.slice(0, 4)}`,
        scope: "pools",
      })
      await store.keys.replaceScopeTargets(row.id, { poolIds })
      return row
    }
    const sole = await key("sole", [stale.id])
    const shared = await key("shared", [stale.id, other.id])
    const dead = await key("dead", [stale.id])
    await store.keys.markRevoked(dead.id, new Date(NOW.getTime() - DAY_MS))

    const outcome = await reaper.reap(stale.id, new Date(NOW.getTime() - 7 * DAY_MS))

    expect(outcome.kind).toBe("reaped")
    const row = store.rows.audit.findLast((audit) => audit.kind === "pool.deleted")?.detail
    expect(row).toMatchObject({
      name: "opencode-go",
      members: [],
      revokedKeyIds: [sole.id],
      detachedKeyIds: [shared.id],
    })
    expect(sorted(row?.keys)).toEqual([
      { keyId: dead.id, name: "dead", fate: "already_revoked" },
      { keyId: shared.id, name: "shared", fate: "detached" },
      { keyId: sole.id, name: "sole", fate: "revoked" },
    ])
    expect(JSON.stringify(row)).not.toContain("v1.k1.cipher")
    expect(JSON.stringify(row)).not.toContain("mar_live_")
  })
})
