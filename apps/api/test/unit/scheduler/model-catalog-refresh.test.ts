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
  const run = () =>
    task.run({
      now: NOW,
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
        account("sub", { provider: "anthropic-oauth" }),
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

  test("a skip is not a failure", async () => {
    const { run } = harness({
      accounts: [account("a")],
      outcome: () => ({ kind: "skipped", reason: "account:disabled" }),
    })

    expect(await run()).toMatchObject({ outcome: "success", itemsProcessed: 0 })
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
