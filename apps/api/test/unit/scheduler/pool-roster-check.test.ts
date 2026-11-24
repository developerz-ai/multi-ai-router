import { describe, expect, mock, test } from "bun:test"
import { type PoolRoster, poolRosterSchema } from "../../../src/config/pool-roster"
import { createLogger } from "../../../src/logging/logger"
import { createMetrics } from "../../../src/observability/metrics"
import { createScheduler } from "../../../src/scheduler"
import {
  createPoolRosterCheckTask,
  createPoolRosterCheckTasks,
} from "../../../src/scheduler/tasks/pool-roster-check"
import { createMemoryStore } from "../../support/memory-store"
import { alwaysFree, memoryTaskRepository, silentLogger } from "./fixtures"

/**
 * The roster check, over the memory store and a real `createMetrics()` — so the gauge assertions
 * read the exposition text an operator would scrape, not a record of the calls that were made.
 *
 * Two runs are the point. The first reports drift; the second, after the fixture is corrected
 * through the ordinary repository call, must report **nothing** — a `clear()`-then-`set()` gauge is
 * what makes a repaired drift disappear instead of lingering at its last count.
 */

const NOW = new Date("2026-08-10T00:00:00.000Z")
const INTERVAL_MS = 15 * 60_000

const ROSTER: PoolRoster = {
  version: 1,
  pools: [
    // The fixture's overflow is alice, so this suite drifts on membership and a missing pool only —
    // the overflow rule has its own coverage in `pool-roster-diff.test.ts`.
    { name: "claude-team", members: ["alice", "bob"], overflow: "alice", quotaSoftLimit: 0.8 },
    { name: "gone-team", members: ["alice", "bob"], overflow: "alice", quotaSoftLimit: 0.8 },
  ],
}

function harness() {
  const store = createMemoryStore()
  const metrics = createMetrics()
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({ level: "info", write: (line) => void lines.push(JSON.parse(line)) })
  const task = createPoolRosterCheckTask({
    roster: ROSTER,
    pools: store.pools,
    accounts: store.accounts,
    recordDrift: (items) => metrics.setRosterDrift(items),
    intervalMs: INTERVAL_MS,
  })
  const tick = () => task.run({ now: NOW, logger, signal: new AbortController().signal })
  const series = (name: string) =>
    metrics
      .expose()
      .split("\n")
      .filter((line) => line.startsWith(`${name}{`))
  return { store, metrics, lines, task, tick, series }
}

/** `claude-team` holding alice but not bob, and no `gone-team` pool at all. */
async function driftFixture(store: ReturnType<typeof createMemoryStore>) {
  // The secrets are the point: they sit in the account rows the check reads *summaries* of, so a
  // fold that used a whole-row read instead would put one in an alert line and fail the leak assert.
  const alice = await store.accounts.create({
    label: "alice",
    provider: "anthropic-oauth",
    authMaterial: "sk-ant-alice-secret",
  })
  const bob = await store.accounts.create({
    label: "bob",
    provider: "anthropic-oauth",
    authMaterial: "sk-ant-bob-secret",
  })
  const pool = await store.pools.create({ name: "claude-team", overflowAccountId: alice.id })
  await store.pools.replaceMembers(pool.id, [{ accountId: alice.id }])
  return { alice, bob, pool }
}

describe("pool_roster_check", () => {
  test("an already cancelled run performs no reads or reporting", async () => {
    const read = mock(async () => [])
    const recordDrift = mock(() => undefined)
    const task = createPoolRosterCheckTask({
      roster: ROSTER,
      pools: { list: read, listMembersForPools: read },
      accounts: { listSummaries: read },
      recordDrift,
      intervalMs: INTERVAL_MS,
    })
    const controller = new AbortController()
    controller.abort()
    const result = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })
    expect(result).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(read).not.toHaveBeenCalled()
    expect(recordDrift).not.toHaveBeenCalled()
  })
  test("the fixture roster is one the loader would accept", () => {
    // `poolRosterSchema` refuses an overflow that is its pool's sole member, so a fixture that
    // broke that rule would exercise a roster no deployment can configure.
    expect(poolRosterSchema.safeParse(ROSTER).success).toBe(true)
  })
  test("reports every drift item as one warn line, and clears them once repaired", async () => {
    const h = harness()
    const { alice, bob, pool } = await driftFixture(h.store)

    const first = await h.tick()

    // Exactly two items: `bob` is a roster member the pool does not hold, and `gone-team` does not
    // exist at all. Nothing else is drifted — the overflow is alice, which is a member.
    expect(first).toEqual({ outcome: "success", itemsProcessed: 2 })

    const alerts = h.lines.filter((line) => line.msg === "pool roster drift")
    expect(alerts).toHaveLength(2)
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          pool: "claude-team",
          poolId: pool.id,
          kind: "missing_member",
          account: "bob",
        }),
        expect.objectContaining({
          level: "warn",
          pool: "gone-team",
          poolId: null,
          kind: "pool_missing",
          account: null,
        }),
      ]),
    )

    // No credential material. The fixtures below carry real-looking secrets in the columns this
    // check must never read, so a fold that started pulling whole account rows would leak one here.
    const text = h.lines.map((line) => JSON.stringify(line)).join("\n")
    expect(text).not.toContain("authMaterial")
    expect(text).not.toContain("sk-ant-")
    expect(text).not.toContain("cipher")

    expect(h.series("router_pool_roster_drift")).toEqual([
      `router_pool_roster_drift{pool_id="${pool.id}",kind="missing_member"} 1`,
      `router_pool_roster_drift{pool_id="gone-team",kind="pool_missing"} 1`,
    ])

    // Correct the fixture the normal way: the pool holds the roster's members and `gone-team`
    // exists with its own.
    await h.store.pools.replaceMembers(pool.id, [{ accountId: alice.id }, { accountId: bob.id }])
    const gone = await h.store.pools.create({ name: "gone-team", overflowAccountId: alice.id })
    await h.store.pools.replaceMembers(gone.id, [{ accountId: alice.id }, { accountId: bob.id }])

    const second = await h.tick()

    expect(second).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(h.lines.filter((line) => line.msg === "pool roster drift")).toHaveLength(2)
    expect(h.series("router_pool_roster_drift")).toEqual([])
  })

  test("a clean roster reads zero series with no alert line", async () => {
    const h = harness()
    const store = h.store
    const alice = await store.accounts.create({ label: "alice", provider: "anthropic-oauth" })
    const bob = await store.accounts.create({ label: "bob", provider: "anthropic-oauth" })
    const team = await store.pools.create({ name: "claude-team", overflowAccountId: alice.id })
    await store.pools.replaceMembers(team.id, [{ accountId: alice.id }, { accountId: bob.id }])
    const gone = await store.pools.create({ name: "gone-team", overflowAccountId: alice.id })
    await store.pools.replaceMembers(gone.id, [{ accountId: alice.id }, { accountId: bob.id }])

    const result = await h.tick()

    expect(result).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(h.lines.filter((line) => line.msg === "pool roster drift")).toEqual([])
    expect(h.series("router_pool_roster_drift")).toEqual([])
  })

  test("no mutation: a drifted fixture is left exactly as it was", async () => {
    const h = harness()
    const { alice } = await driftFixture(h.store)
    const before = {
      accounts: h.store.rows.accounts.map((row) => [row.id, row.label, row.status]),
      pools: h.store.rows.pools.map((row) => [row.id, row.name, row.overflowAccountId]),
      members: h.store.rows.poolMembers.map((row) => [row.poolId, row.accountId]),
    }

    await h.tick()

    expect(h.store.rows.accounts.map((row) => [row.id, row.label, row.status])).toEqual(
      before.accounts,
    )
    expect(h.store.rows.pools.map((row) => [row.id, row.name, row.overflowAccountId])).toEqual(
      before.pools,
    )
    expect(h.store.rows.poolMembers.map((row) => [row.poolId, row.accountId])).toEqual(
      before.members,
    )
    // And the fixture is still the drifted one, not a silently repaired pool.
    expect(h.store.rows.poolMembers.map((row) => row.accountId)).toEqual([alice.id])
    expect(h.store.rows.pools.map((row) => row.overflowAccountId)).toEqual([alice.id])
  })

  test("the factory builds no task when the port is absent, and one when it is", () => {
    expect(createPoolRosterCheckTasks(undefined, { intervalMs: INTERVAL_MS })).toEqual([])

    const h = harness()
    const tasks = createPoolRosterCheckTasks(
      {
        roster: ROSTER,
        pools: h.store.pools,
        accounts: h.store.accounts,
        recordDrift: (items) => h.metrics.setRosterDrift(items),
      },
      { intervalMs: INTERVAL_MS },
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.name).toBe("pool_roster_check")
    // The cadence is the config value, not a constant inside the task.
    expect(tasks[0]?.intervalMs).toBe(INTERVAL_MS)
  })

  test("a null cadence also builds nothing, so no task ever spins on a 0 ms timer", () => {
    const h = harness()
    const ports = {
      roster: ROSTER,
      pools: h.store.pools,
      accounts: h.store.accounts,
      recordDrift: () => undefined,
    }
    expect(createPoolRosterCheckTasks(ports, { intervalMs: null })).toEqual([])
    expect(createPoolRosterCheckTasks(ports, { intervalMs: INTERVAL_MS })).toHaveLength(1)
  })

  test("through the runner, one tick records a success run row with its item count", async () => {
    // The task's own `run()` is not the whole contract: the runner owns the advisory lock and the
    // `scheduled_task_runs` row, so a task that silently stopped being recorded would still pass
    // every assertion above. Drive the real `createScheduler` and read the row it persisted.
    const h = harness()
    await driftFixture(h.store)
    const repo = memoryTaskRepository()
    const scheduler = createScheduler({
      tasks: [
        createPoolRosterCheckTask({
          roster: ROSTER,
          pools: h.store.pools,
          accounts: h.store.accounts,
          recordDrift: (items) => h.metrics.setRosterDrift(items),
          intervalMs: INTERVAL_MS,
        }),
      ],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
      now: () => NOW,
    })

    const tick = await scheduler.runNow("pool_roster_check")

    expect(tick.status).toBe("success")
    expect(repo.rows).toHaveLength(1)
    const row = repo.rows[0]
    if (row === undefined) throw new Error("the runner recorded no run row")
    // The id is minted by the runner's `begin`, so this asserts its type instead of echoing it back
    // into an equality that could never fail; every field the task itself owns is matched exactly.
    expect(typeof row.id).toBe("string")
    expect(row).toMatchObject({
      task: "pool_roster_check",
      startedAt: NOW,
      finishedAt: NOW,
      outcome: "success",
      itemsProcessed: 2,
      error: null,
    })
    // The row and the gauge come from the same run, so a tick that stopped reporting either would
    // fail here rather than leaving the other to claim the check works.
    expect(h.series("router_pool_roster_drift")).toHaveLength(2)
  })

  test("a failed read returns failed, not a task that throws", async () => {
    const metrics = createMetrics()
    const task = createPoolRosterCheckTask({
      roster: ROSTER,
      pools: {
        list: async () => {
          throw new Error("connection reset")
        },
        listMembersForPools: async () => [],
      },
      accounts: { listSummaries: async () => [] },
      recordDrift: (items) => metrics.setRosterDrift(items),
      intervalMs: INTERVAL_MS,
    })

    const result = await task.run({
      now: NOW,
      logger: createLogger({ level: "error", write: () => undefined }),
      signal: new AbortController().signal,
    })

    expect(result.outcome).toBe("failed")
    expect(result.itemsProcessed).toBe(0)
    expect(result.error).toContain("connection reset")
  })
})
