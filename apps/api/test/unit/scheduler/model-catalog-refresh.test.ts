import { describe, expect, test } from "bun:test"
import type { AccountRow, ModelCatalogRepository } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createModelCatalogRefreshTask } from "../../../src/scheduler"
import type { CatalogRefreshOutcome } from "../../../src/services/models"
import { accountRow as durableAccountRow } from "../../support/account-row"

/**
 * The hourly catalog sweep's loop: batching, ordering, abort, and what it reports.
 *
 * The refresh itself is handed in — its own tests live beside it — so what is left here is the
 * property a scheduled task is judged on: that a deployment with more accounts than one batch
 * actually reaches all of them, that a shutdown never lands mid-account, and that the
 * ask-in-vain stamps survive the process that made them — the advisory lock hands the next tick
 * to a different replica more often than not, so the per-replica Map this once was is gone.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function account(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return durableAccountRow({ id, label: id, provider: "zai", status: "active", ...overrides })
}

/**
 * The `model_catalog_attempts` half of the repository, over a map the test owns — the contract
 * the SQL must keep, mirrored here: an out-of-order `recordAttempt` never moves a stamp
 * backwards (the upsert takes `GREATEST`), and clearing an absent row is a no-op.
 */
type AttemptLedger = Pick<
  ModelCatalogRepository,
  "lastAttemptedAt" | "recordAttempt" | "clearAttempt"
>

function attemptLedger(attempts: Map<string, Date>): AttemptLedger {
  return {
    lastAttemptedAt: async () =>
      [...attempts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([accountId, attemptedAt]) => ({ accountId, attemptedAt })),
    recordAttempt: async (accountId, attemptedAt) => {
      const previous = attempts.get(accountId)
      if (previous === undefined || previous.getTime() < attemptedAt.getTime())
        attempts.set(accountId, attemptedAt)
    },
    clearAttempt: async (accountId) => {
      attempts.delete(accountId)
    },
  }
}

/** A bare run with no captured logs — the multi-instance tests judge the asks, not the lines. */
function tick(task: ReturnType<typeof createModelCatalogRefreshTask>, at: Date) {
  return task.run({
    now: at,
    signal: new AbortController().signal,
    logger: createLogger({ level: "debug", write: () => undefined }),
  })
}

const HOUR = 3_600_000

/**
 * A batchSize-1 task whose asks are recorded and whose outcome is chosen per account. Refreshed
 * accounts write `refreshed_at` into `refreshedAt` when given, the way the real repository's
 * `replaceForAccount` would, so ordering after a success mirrors production.
 */
function failingTask(options: {
  readonly accounts: readonly AccountRow[]
  readonly attempts: Map<string, Date>
  readonly refreshedAt?: Map<string, Date>
  readonly batchSize?: number
  readonly outcome?: (account: AccountRow) => CatalogRefreshOutcome
}) {
  const asked: string[] = []
  const ages = options.refreshedAt ?? new Map<string, Date>()
  const task = createModelCatalogRefreshTask({
    accounts: { list: async () => [...options.accounts] },
    catalog: {
      lastRefreshedAt: async () =>
        [...ages].map(([accountId, refreshedAt]) => ({ accountId, refreshedAt })),
      ...attemptLedger(options.attempts),
    },
    refresh: async (row, at) => {
      asked.push(row.id)
      const outcome = options.outcome?.(row) ?? { kind: "failed", reason: "discovery_failed" }
      if (outcome.kind === "refreshed") ages.set(row.id, at)
      return outcome
    },
    intervalMs: HOUR,
    batchSize: options.batchSize ?? 1,
    startupDelayMs: 30_000,
  })
  return { task, asked }
}

function harness(options: {
  readonly accounts: readonly AccountRow[]
  readonly ages?: readonly { accountId: string; refreshedAt: Date }[]
  readonly attempts?: ReadonlyMap<string, Date>
  readonly outcome?: (account: AccountRow) => CatalogRefreshOutcome
  readonly batchSize?: number
  readonly aborted?: boolean
}) {
  const attempts = new Map(options.attempts ?? [])
  const refreshed: string[] = []
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()

  const task = createModelCatalogRefreshTask({
    accounts: { list: async () => [...options.accounts] },
    catalog: {
      lastRefreshedAt: async () => options.ages ?? [],
      ...attemptLedger(attempts),
    },
    refresh: async (account) => {
      refreshed.push(account.id)
      return options.outcome?.(account) ?? { kind: "refreshed", models: 3 }
    },
    intervalMs: HOUR,
    batchSize: options.batchSize ?? 25,
    startupDelayMs: 30_000,
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

  return { run, refreshed, logs, attempts }
}

describe("the hourly model-catalog sweep", () => {
  test("refreshes what is due and counts the models it stored", async () => {
    const { run, refreshed } = harness({ accounts: [account("a"), account("b")] })

    const result = await run()

    expect(refreshed).toEqual(["a", "b"])
    expect(result).toMatchObject({ outcome: "success", itemsProcessed: 2 })
  })

  test("a refresh that carries a note (a truncated listing) says so", async () => {
    const { run, logs } = harness({
      accounts: [account("a")],
      outcome: () => ({ kind: "refreshed", models: 100, detail: "listing:truncated" }),
    })

    await run()

    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "model catalog refreshed with a note",
        accountId: "a",
        detail: "listing:truncated",
      }),
    )
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
    const { run, refreshed, logs, attempts } = harness({
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
    // The failure is stamped for the next tick; the success has no row to answer for.
    expect(attempts.get("bad")?.getTime()).toBe(NOW.getTime())
    expect(attempts.has("good")).toBe(false)
  })

  /**
   * Production: an endpoint with no model listing answered `discovery_failed` every hour, never
   * acquired a `refreshed_at`, and so sorted first on every tick — with a batch's worth of those,
   * nothing else is ever asked.
   */
  test("an account whose listing always fails does not hold the head of the queue", async () => {
    const accounts = [account("a-dead"), account("b"), account("c")]
    const attempts = new Map<string, Date>()
    const outcome = (row: AccountRow): CatalogRefreshOutcome =>
      row.id === "a-dead"
        ? { kind: "failed", reason: "discovery_failed" }
        : { kind: "refreshed", models: 1 }
    const { task, asked } = failingTask({ accounts, attempts, outcome })

    await tick(task, NOW)
    await tick(task, new Date(NOW.getTime() + HOUR))
    await tick(task, new Date(NOW.getTime() + 2 * HOUR))
    await tick(task, new Date(NOW.getTime() + 3 * HOUR))

    // One slot per tick: the dead account takes its turn, then waits behind the others — and
    // comes round again, because being asked in vain is not being dropped.
    expect(asked).toEqual(["a-dead", "b", "c", "a-dead"])
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
    await run(new Date(NOW.getTime() + HOUR))

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
    const attempts = new Map<string, Date>()
    const { task, asked } = failingTask({ accounts: fleet, attempts })

    await tick(task, NOW)
    // Postgres cascades the attempt row with the account (FK ON DELETE CASCADE) — the sweep no
    // longer prunes anything itself, so the fake mirrors the cascade the database performs.
    fleet.shift()
    attempts.delete("a-dead")
    await tick(task, new Date(NOW.getTime() + HOUR))
    // `c` has never been asked either. A surviving entry would rank the returned account behind
    // it; cascaded, the two tie and the id decides.
    fleet.unshift(account("a-dead"))
    fleet.push(account("c"))
    await tick(task, new Date(NOW.getTime() + 2 * HOUR))

    expect(asked).toEqual(["a-dead", "b", "a-dead"])
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
    const { task } = built({ intervalMs: HOUR })

    expect(task.startupDelayMs).toBe(30_000)
    expect(task.intervalMs).toBe(HOUR)
  })

  test("never delays the first tick past a cadence shorter than the delay itself", () => {
    // A deployment configuring a one-second refresh must not wait thirty for its first run.
    expect(built({ intervalMs: 1_000 }).task.startupDelayMs).toBe(1_000)
  })

  test("takes the first-tick delay from config (07.3)", () => {
    expect(built({ intervalMs: HOUR, startupDelayMs: 5_000 }).task.startupDelayMs).toBe(5_000)
    expect(built({ intervalMs: 2_000, startupDelayMs: 5_000 }).task.startupDelayMs).toBe(2_000)
  })
})

describe("durable attempt stamps", () => {
  /**
   * Failure case first — the fingerprint of what the per-replica Map did. A task constructed
   * fresh saw an empty Map, so the never-answering head of the queue was re-asked by every new
   * process. Seeded from the store instead, a fresh instance must honour the stamp.
   */
  test("a fresh instance honours a failed attempt it did not record", async () => {
    const { run, refreshed } = harness({
      accounts: [account("a"), account("b"), account("c")],
      attempts: new Map([["a", NOW]]),
    })

    await run()

    // Another process already asked `a` in vain; the never-asked accounts outrank it.
    expect(refreshed).toEqual(["b", "c", "a"])
  })

  /**
   * What consecutive advisory-lock winners are: two task instances over one
   * `model_catalog_attempts`, no in-memory state in common.
   */
  test("two instances over one store rotate instead of re-asking each other's failures", async () => {
    const accounts = [account("a"), account("b"), account("c")]
    const attempts = new Map<string, Date>()
    const first = failingTask({ accounts, attempts })
    const second = failingTask({ accounts, attempts })

    await tick(first.task, NOW)
    await tick(second.task, new Date(NOW.getTime() + HOUR))
    await tick(first.task, new Date(NOW.getTime() + 2 * HOUR))

    // Under the per-replica Map the second instance knew nothing of the first's stamp and asked
    // the same failing head again; shared, the sweep rotates on.
    expect(first.asked).toEqual(["a", "c"])
    expect(second.asked).toEqual(["b"])
    expect([...attempts.keys()]).toEqual(["a", "b", "c"])
  })

  test("rotation survives a restart, and a success clears the stamp it answers", async () => {
    const accounts = [account("a"), account("b")]
    const attempts = new Map<string, Date>()
    let asksOfA = 0
    // `a` fails once, then answers; `b` answers straight away.
    const outcome = (row: AccountRow): CatalogRefreshOutcome => {
      if (row.id !== "a") return { kind: "refreshed", models: 1 }
      asksOfA += 1
      return asksOfA === 1
        ? { kind: "failed", reason: "discovery_failed" }
        : { kind: "refreshed", models: 2 }
    }

    // The predecessor's process asked `a` in vain and exited.
    const predecessor = failingTask({ accounts, attempts, outcome })
    await tick(predecessor.task, NOW)
    expect(attempts.get("a")?.getTime()).toBe(NOW.getTime())

    // The restart: a task built from nothing inherits the stamp and asks `b`, not `a` again.
    const restarted = failingTask({ accounts, attempts, outcome })
    await tick(restarted.task, new Date(NOW.getTime() + HOUR))
    expect(restarted.asked).toEqual(["b"])

    // Back to `a` — its stamp is the older of the two — and this time the listing lands, so the
    // row's job is done and the store is left empty rather than growing forever.
    await tick(restarted.task, new Date(NOW.getTime() + 2 * HOUR))
    expect(restarted.asked).toEqual(["b", "a"])
    expect(attempts.size).toBe(0)
  })
})

function built(options: { readonly intervalMs: number; readonly startupDelayMs?: number }) {
  const task = createModelCatalogRefreshTask({
    accounts: { list: async () => [] },
    catalog: {
      lastRefreshedAt: async () => [],
      ...attemptLedger(new Map()),
    },
    refresh: async () => ({ kind: "skipped", reason: "test" }),
    intervalMs: options.intervalMs,
    batchSize: 1,
    startupDelayMs: options.startupDelayMs ?? 30_000,
  })
  return { task }
}
