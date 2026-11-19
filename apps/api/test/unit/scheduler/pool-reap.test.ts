import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createPoolReapTask } from "../../../src/scheduler/tasks/pool-reap"
import { createPoolReaper, planKeyFates } from "../../../src/services/pools"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"

/**
 * The empty-pool reap. A pool memberless for the window is deleted; a key scoped only to pools that
 * are all gone is revoked, and a key holding anything else just loses the pool. Each deletion and
 * revocation is a `warn` alert line naming the ids.
 */

const NOW = new Date("2026-08-10T00:00:00.000Z")
const DAY_MS = 24 * 60 * 60_000
const WINDOW_MS = 7 * DAY_MS

function harness(batchSize = 100) {
  const store = createMemoryStore()
  const revoked: string[] = []
  const detached: string[] = []
  let catalogRefreshes = 0
  const reaper = createPoolReaper({
    logger: silentLogger(),
    mutations: store.mutations,
    now: () => NOW,
    coherence: {
      refreshCatalog: async () => {
        catalogRefreshes += 1
      },
      forgetKey: (id) => void revoked.push(id),
      invalidateKey: (id) => void detached.push(id),
    },
  })
  const task = createPoolReapTask({
    pools: store.pools,
    reaper,
    windowMs: WINDOW_MS,
    intervalMs: 60 * 60_000,
    batchSize,
  })
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({ level: "info", write: (line) => void lines.push(JSON.parse(line)) })
  const tick = () => task.run({ now: NOW, logger, signal: new AbortController().signal })

  const pool = async (name: string, emptyForDays: number | null) => {
    const row = await store.pools.create({ name })
    const held = store.rows.pools.find((candidate) => candidate.id === row.id)
    if (held === undefined) throw new Error("pool not stored")
    held.emptySince = emptyForDays === null ? null : new Date(NOW.getTime() - emptyForDays * DAY_MS)
    return row
  }
  let prefix = 0
  const key = async (name: string, poolIds: string[], scope: "pools" | "accounts" = "pools") => {
    const row = await store.keys.create({
      name,
      value: "cipher",
      prefix: `mar_live_reap${String(prefix++).padStart(3, "0")}`,
      scope,
    })
    await store.keys.replaceScopeTargets(row.id, { poolIds })
    return row
  }
  const isRevoked = (id: string) => store.rows.keys.find((row) => row.id === id)?.revoked
  return {
    store,
    reaper,
    tick,
    lines,
    pool,
    key,
    isRevoked,
    revoked,
    detached,
    refreshes: () => catalogRefreshes,
  }
}

describe("planKeyFates", () => {
  test("a pools-scoped key with nothing else left is revoked; anything else is detached", () => {
    const fates = planKeyFates(
      [
        { id: "only", scope: "pools", revoked: false },
        { id: "more", scope: "pools", revoked: false },
        { id: "gone", scope: "pools", revoked: true },
        { id: "odd", scope: "all", revoked: false },
      ],
      new Map([
        ["only", []],
        ["more", ["pool-b"]],
        ["gone", []],
      ]),
    )
    expect(fates).toEqual({ revoke: ["only"], detach: ["more", "odd"] })
  })
})

describe("pool_reap", () => {
  test("a pool empty past the window is deleted, and its sole-target key revoked", async () => {
    const h = harness()
    const stale = await h.pool("stale", 8)
    const other = await h.pool("other", null)
    const sole = await h.key("sole", [stale.id])
    const shared = await h.key("shared", [stale.id, other.id])

    const result = await h.tick()

    expect(result).toEqual({ outcome: "success", itemsProcessed: 1 })
    expect(h.store.rows.pools.map((row) => row.name)).toEqual(["other"])
    expect(h.isRevoked(sole.id)).toBe(true)
    expect(h.isRevoked(shared.id)).toBe(false)
    expect(h.revoked).toEqual([sole.id])
    expect(h.detached).toEqual([shared.id])
    expect(h.refreshes()).toBe(1)

    const poolAlert = h.lines.find((line) => line.msg === "empty pool reaped")
    expect(poolAlert).toMatchObject({
      level: "warn",
      poolId: stale.id,
      revokedKeyIds: [sole.id],
      detachedKeyIds: [shared.id],
    })
    const keyAlerts = h.lines.filter(
      (line) => line.msg === "key revoked: every pool it was scoped to was reaped",
    )
    expect(keyAlerts).toEqual([
      expect.objectContaining({ level: "warn", keyId: sole.id, poolId: stale.id }),
    ])
    const kinds = h.store.rows.audit.map((row) => [row.kind, row.subjectId])
    expect(kinds).toEqual([
      ["key.revoked", sole.id],
      ["pool.deleted", stale.id],
    ])
  })

  test("a pool empty for less than the window, or holding a member, is left alone", async () => {
    const h = harness()
    const young = await h.pool("young", 6)
    const full = await h.pool("full", null)
    await h.key("young-key", [young.id])
    await h.key("full-key", [full.id])

    expect(await h.tick()).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(h.store.rows.pools).toHaveLength(2)
    expect(h.revoked).toEqual([])
    expect(h.lines.some((line) => line.level === "warn")).toBe(false)
  })

  test("a member added after the candidate read wins: the reap re-checks under the lock", async () => {
    const h = harness()
    const raced = await h.pool("raced", 8)
    const account = await h.store.accounts.create({
      label: "a",
      provider: "zai",
      authMaterial: "c",
    })
    await h.store.pools.replaceMembers(raced.id, [{ accountId: account.id }])

    const outcome = await h.reaper.reap(raced.id, new Date(NOW.getTime() - WINDOW_MS))

    expect(outcome).toEqual({ kind: "skipped", poolId: raced.id, reason: "has_members" })
    expect(h.store.rows.pools).toHaveLength(1)
  })

  test("a key whose pools are all reaped across the tick ends revoked, not detached twice", async () => {
    const h = harness()
    const first = await h.pool("first", 9)
    const second = await h.pool("second", 8)
    const both = await h.key("both", [first.id, second.id])

    expect(await h.tick()).toEqual({ outcome: "success", itemsProcessed: 2 })

    // The first reap detaches (the second pool survives it); the second finds nothing else left.
    expect(h.detached).toEqual([both.id])
    expect(h.revoked).toEqual([both.id])
    expect(h.isRevoked(both.id)).toBe(true)
    expect(h.store.rows.pools).toEqual([])
  })

  test("an account-scoped or already-revoked key is never revoked by a reap", async () => {
    const h = harness()
    const stale = await h.pool("stale", 30)
    const direct = await h.key("direct", [stale.id], "accounts")
    const dead = await h.key("dead", [stale.id])
    await h.store.keys.markRevoked(dead.id, new Date(NOW.getTime() - DAY_MS))

    await h.tick()

    expect(h.isRevoked(direct.id)).toBe(false)
    expect(h.revoked).toEqual([])
    expect(h.store.rows.audit.map((row) => row.kind)).toEqual(["pool.deleted"])
  })

  test("more due than one batch is partial, longest-empty first", async () => {
    const h = harness(1)
    await h.pool("newer", 8)
    await h.pool("older", 20)

    expect(await h.tick()).toEqual({ outcome: "partial", itemsProcessed: 1 })
    expect(h.store.rows.pools.map((row) => row.name)).toEqual(["newer"])
  })

  test("a pool already gone is a skip, so a re-run is idempotent", async () => {
    const h = harness()
    expect(await h.reaper.reap("00000000-0000-4000-8000-000000000000", NOW)).toEqual({
      kind: "skipped",
      poolId: "00000000-0000-4000-8000-000000000000",
      reason: "gone",
    })
  })
})
