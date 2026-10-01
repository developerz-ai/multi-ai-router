import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createModelCatalogRefreshTask } from "../../../src/scheduler"
import type { CatalogRefreshOutcome } from "../../../src/services/models"

/**
 * The hourly catalog sweep's loop: batching, ordering, abort, and what it reports.
 *
 * The refresh itself is handed in — its own tests live beside it — so what is left here is the
 * property a scheduled task is judged on: that a deployment with more accounts than one batch
 * actually reaches all of them, and that a shutdown never lands mid-account.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function account(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return { id, label: id, provider: "zai", status: "active", ...overrides } as AccountRow
}

function harness(options: {
  readonly accounts: readonly AccountRow[]
  readonly ages?: readonly { accountId: string; refreshedAt: Date }[]
  readonly outcome?: (account: AccountRow) => CatalogRefreshOutcome
  readonly batchSize?: number
  readonly aborted?: boolean
}) {
  const refreshed: string[] = []
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()

  const task = createModelCatalogRefreshTask({
    accounts: { list: async () => [...options.accounts] },
    catalog: { lastRefreshedAt: async () => options.ages ?? [] },
    refresh: async (account) => {
      refreshed.push(account.id)
      return options.outcome?.(account) ?? { kind: "refreshed", models: 3 }
    },
    intervalMs: 3_600_000,
    batchSize: options.batchSize ?? 25,
  })

  const logs: Record<string, unknown>[] = []
  const run = (now: Date = NOW) =>
    task.run({
      now,
      signal: controller.signal,
      logger: createLogger({
        level: "debug",
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
    })

  return { run, refreshed, logs }
}

describe("the hourly model-catalog sweep", () => {
  test("refreshes what is due and counts the models it stored", async () => {
    const { run, refreshed } = harness({ accounts: [account("a"), account("b")] })

    const result = await run()

    expect(refreshed).toEqual(["a", "b"])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 2 })
  })

  /**
   * The reason the task orders instead of slicing. A naive `accounts.slice(0, batchSize)` would
   * refresh `a` and `b` every hour forever while `c` kept the catalog it was created with.
   */
  test("a fleet larger than one batch rotates rather than starving its tail", async () => {
    const accounts = [account("a"), account("b"), account("c")]
    const ages = [
      { accountId: "a", refreshedAt: new Date("2026-07-28T11:00:00.000Z") },
      { accountId: "b", refreshedAt: new Date("2026-07-28T10:00:00.000Z") },
      // `c` has never been refreshed and is therefore the most urgent, not the least.
    ]

    const { run, refreshed } = harness({ accounts, ages, batchSize: 2 })
    await run()

    expect(refreshed).toEqual(["c", "b"])
  })

  test("accounts with nothing to ask never enter the batch", async () => {
    const { run, refreshed } = harness({
      accounts: [
        account("sub", { provider: "anthropic-oauth", status: "needs_reauth" }),
        account("aggregator", { provider: "openrouter" }),
        account("real"),
      ],
      batchSize: 2,
    })

    const result = await run()

    // Two slots, and both would have gone to accounts that cannot be refreshed if the filter ran
    // after the cap instead of before it.
    expect(refreshed).toEqual(["real"])
    expect(result.outcome).toBe("success")
  })

  test("a failure is partial, named, and does not stop the rest of the batch", async () => {
    const { run, refreshed, logs } = harness({
      accounts: [account("bad"), account("good")],
      outcome: (account) =>
        account.id === "bad"
          ? { kind: "failed", reason: "discovery_failed" }
          : { kind: "refreshed", models: 1 },
    })

    const result = await run()

    expect(refreshed).toEqual(["bad", "good"])
    expect(result).toMatchObject({ outcome: "partial", itemsProcessed: 1 })
    expect(logs.some((line) => line.reason === "discovery_failed")).toBe(true)
  })

  /**
   * Production: an endpoint with no model listing answered `discovery_failed` every hour, never
   * acquired a `refreshed_at`, and so sorted first on every tick — with a batch's worth of those,
   * nothing else is ever asked.
   */
  test("an account whose listing always fails does not hold the head of the queue", async () => {
    const accounts = [account("a-dead"), account("b"), account("c")]
    const stored = new Map<string, Date>()
    const order: string[] = []
    let clock = NOW
    const task = createModelCatalogRefreshTask({
      accounts: { list: async () => accounts },
      catalog: {
        lastRefreshedAt: async () =>
          [...stored].map(([accountId, refreshedAt]) => ({ accountId, refreshedAt })),
      },
      refresh: async (row) => {
        order.push(row.id)
        if (row.id === "a-dead") return { kind: "failed", reason: "discovery_failed" }
        stored.set(row.id, clock)
        return { kind: "refreshed", models: 1 }
      },
      intervalMs: 3_600_000,
      batchSize: 1,
    })
    const tick = async (at: Date) => {
      clock = at
      await task.run({
        now: at,
        signal: new AbortController().signal,
        logger: createLogger({ level: "debug", write: () => undefined }),
      })
    }

    await tick(NOW)
    await tick(new Date(NOW.getTime() + 3_600_000))
    await tick(new Date(NOW.getTime() + 7_200_000))
    await tick(new Date(NOW.getTime() + 10_800_000))

    // One slot per tick: the dead account takes its turn, then waits behind the others — and
    // comes round again, because being asked in vain is not being dropped.
    expect(order).toEqual(["a-dead", "b", "c", "a-dead"])
  })

  test("an account skipped for having no listing rotates the same way", async () => {
    const { run, refreshed } = harness({
      accounts: [account("a-none"), account("b")],
      outcome: (row) =>
        row.id === "a-none"
          ? { kind: "skipped", reason: "http:no-model-listing", detail: "http-status:404" }
          : { kind: "failed", reason: "discovery_failed" },
      batchSize: 1,
    })

    await run(NOW)
    await run(new Date(NOW.getTime() + 3_600_000))

    expect(refreshed).toEqual(["a-none", "b"])
  })

  test("a failure and a skip both log the listing's own detail beside the stable reason", async () => {
    const { run, logs } = harness({
      accounts: [account("bad"), account("none")],
      outcome: (row) =>
        row.id === "bad"
          ? {
              kind: "failed",
              reason: "discovery_failed",
              detail: "could not read the model listing: http-status:401",
            }
          : {
              kind: "skipped",
              reason: "http:no-model-listing",
              detail: "could not read the model listing: http-status:404",
            },
    })

    await run()

    expect(
      logs.find((line) => line.msg === "model catalog refresh failed for an account"),
    ).toMatchObject({
      level: "warn",
      reason: "discovery_failed",
      detail: "could not read the model listing: http-status:401",
    })
    expect(
      logs.find((line) => line.msg === "model catalog refresh skipped an account"),
    ).toMatchObject({
      level: "info",
      reason: "http:no-model-listing",
      detail: "could not read the model listing: http-status:404",
    })
  })

  test("an account that left the fleet takes its attempt record with it", async () => {
    const fleet = [account("a-dead"), account("b")]
    const order: string[] = []
    const task = createModelCatalogRefreshTask({
      accounts: { list: async () => [...fleet] },
      catalog: { lastRefreshedAt: async () => [] },
      refresh: async (row) => {
        order.push(row.id)
        return { kind: "failed", reason: "discovery_failed" }
      },
      intervalMs: 3_600_000,
      batchSize: 1,
    })
    const tick = (at: Date) =>
      task.run({
        now: at,
        signal: new AbortController().signal,
        logger: createLogger({ level: "debug", write: () => undefined }),
      })

    await tick(NOW)
    // Deleted and re-created under the same id: it is a new account, never asked, so it is first.
    fleet.shift()
    await tick(new Date(NOW.getTime() + 3_600_000))
    // `c` has never been asked either. A stale entry would rank the newcomer behind it; pruned,
    // the two tie and the id decides.
    fleet.unshift(account("a-dead"))
    fleet.push(account("c"))
    await tick(new Date(NOW.getTime() + 7_200_000))

    expect(order).toEqual(["a-dead", "b", "a-dead"])
  })

  test("a skip is not a failure, and says why at info", async () => {
    const { run, logs } = harness({
      accounts: [account("sub", { provider: "anthropic-oauth" })],
      outcome: () => ({ kind: "skipped", reason: "agent-sdk:no-config-dir" }),
    })

    expect(await run()).toMatchObject({ outcome: "success", itemsProcessed: 0 })
    // One dead subscription must not turn the tick partial, but it must not vanish either.
    const skipped = logs.find((line) => line.msg === "model catalog refresh skipped an account")
    expect(skipped).toMatchObject({
      level: "info",
      accountId: "sub",
      provider: "anthropic-oauth",
      reason: "agent-sdk:no-config-dir",
    })
  })

  test("an aborted run stops before the first account and reports partial", async () => {
    const { run, refreshed } = harness({ accounts: [account("a")], aborted: true })

    const result = await run()

    expect(refreshed).toEqual([])
    expect(result.outcome).toBe("partial")
  })

  test("nothing to do is a quiet success", async () => {
    expect(await harness({ accounts: [] }).run()).toMatchObject({
      outcome: "success",
      itemsProcessed: 0,
    })
  })

  /** So a deployment whose catalog is permanently lagging is visible rather than inferred. */
  test("the summary reports how many were due beside how many exist", async () => {
    const { run, logs } = harness({
      accounts: [account("a"), account("b"), account("c")],
      batchSize: 2,
    })

    await run()

    const summary = logs.find((line) => line.msg === "model catalog refresh")
    expect(summary).toMatchObject({ due: 2, accounts: 3, models: 6 })
  })

  /**
   * The catalog is the one sweep whose absence is *visible*: `GET /v1/catalog` reads what it
   * writes, so a full interval of `data: []` after a fresh deploy reads as a broken endpoint.
   */
  test("asks for an early first tick, without changing its own cadence", () => {
    const { task } = built({ intervalMs: 3_600_000 })

    expect(task.startupDelayMs).toBe(30_000)
    expect(task.intervalMs).toBe(3_600_000)
  })

  test("never delays the first tick past a cadence shorter than the delay itself", () => {
    // A deployment configuring a one-second refresh must not wait thirty for its first run.
    expect(built({ intervalMs: 1_000 }).task.startupDelayMs).toBe(1_000)
  })
})

function built(options: { readonly intervalMs: number }) {
  const task = createModelCatalogRefreshTask({
    accounts: { list: async () => [] },
    catalog: { lastRefreshedAt: async () => [] },
    refresh: async () => ({ kind: "skipped", reason: "test" }),
    intervalMs: options.intervalMs,
    batchSize: 1,
  })
  return { task }
}
