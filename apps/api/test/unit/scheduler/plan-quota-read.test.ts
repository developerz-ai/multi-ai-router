import { describe, expect, test } from "bun:test"
import type { QuotaWindowRow } from "@multi-ai-router/db"
import { createPlanQuotaReadTask } from "../../../src/scheduler"
import type { RoutableAccount } from "../../../src/services/dataplane"
import { routableStandIn } from "../../../src/services/dataplane"
import type { PlanQuotaOutcome } from "../../../src/services/models"
import { accountRow } from "../../support/account-row"
import { silentLogger } from "./fixtures"

/** The sweep's loop: bounds, rotation, abort, and what a run reports. The read is handed in. */

const NOW = new Date("2026-11-06T12:00:00.000Z")
const INTERVAL = 15 * 60_000

function go(id: string): RoutableAccount {
  const row = accountRow({
    id,
    label: id,
    provider: "opencode-go",
    status: "active",
    baseUrl: null,
  })
  return routableStandIn(row, { id, provider: "opencode-go", baseUrl: null })
}

function task(
  accounts: readonly RoutableAccount[],
  read: (account: RoutableAccount) => Promise<PlanQuotaOutcome>,
  options: { batchSize?: number; windows?: readonly Partial<QuotaWindowRow>[] } = {},
) {
  return createPlanQuotaReadTask({
    accounts: () => accounts,
    read,
    windows: { listQuotaWindows: async () => (options.windows ?? []) as QuotaWindowRow[] },
    intervalMs: INTERVAL,
    batchSize: options.batchSize ?? 10,
  })
}

const tick = (
  run: ReturnType<typeof task>,
  at: Date = NOW,
  signal = new AbortController().signal,
) => run.run({ now: at, signal, logger: silentLogger() })

describe("the plan quota sweep, failures first", () => {
  test("a failed read is a partial run, and the rest of the batch is still asked", async () => {
    const asked: string[] = []
    const result = await tick(
      task([go("a"), go("b")], async (account) => {
        asked.push(account.id)
        return account.id === "a" ? { kind: "failed", reason: "http-status:500" } : { kind: "read" }
      }),
    )

    expect(asked).toEqual(["a", "b"])
    expect(result).toEqual({ outcome: "partial", itemsProcessed: 1 })
  })

  test("a key with no plan is a skip, not a failure", async () => {
    const result = await tick(
      task([go("a")], async () => ({ kind: "skipped", reason: "quota:no-plan" })),
    )
    expect(result).toEqual({ outcome: "success", itemsProcessed: 0 })
  })

  test("an abort stops between accounts", async () => {
    const controller = new AbortController()
    const asked: string[] = []
    const result = await tick(
      task([go("a"), go("b")], async (account) => {
        asked.push(account.id)
        controller.abort()
        return { kind: "read" }
      }),
      NOW,
      controller.signal,
    )

    expect(asked).toEqual(["a"])
    expect(result).toEqual({ outcome: "partial", itemsProcessed: 1 })
  })

  test("accounts that cannot be read never consume the batch", async () => {
    const moved = routableStandIn(
      accountRow({ id: "moved", provider: "opencode-go", status: "active" }),
      { id: "moved", provider: "opencode-go", baseUrl: "https://proxy.example/v1" },
    )
    const zai = routableStandIn(accountRow({ id: "zai", provider: "zai", status: "active" }), {
      id: "zai",
      provider: "zai",
    })
    const asked: string[] = []
    await tick(
      task(
        [moved, zai, go("a")],
        async (account) => {
          asked.push(account.id)
          return { kind: "read" }
        },
        { batchSize: 1 },
      ),
    )
    expect(asked).toEqual(["a"])
  })
})

describe("the plan quota sweep", () => {
  test("a batch smaller than the fleet rotates instead of re-asking the same accounts", async () => {
    const asked: string[] = []
    const run = task(
      [go("a"), go("b"), go("c")],
      async (account) => {
        asked.push(account.id)
        return { kind: "skipped", reason: "quota:no-plan" }
      },
      { batchSize: 2 },
    )

    expect((await tick(run)).outcome).toBe("partial")
    await tick(run, new Date(NOW.getTime() + INTERVAL))

    expect(asked).toEqual(["a", "b", "c", "a"])
  })

  test("a reading another replica just took is not asked for again", async () => {
    const asked: string[] = []
    await tick(
      task(
        [go("a"), go("b")],
        async (account) => {
          asked.push(account.id)
          return { kind: "read" }
        },
        { windows: [{ accountId: "a", lastCheckedAt: new Date(NOW.getTime() - 1_000) }] },
      ),
    )
    expect(asked).toEqual(["b"])
  })

  test("a tick the jitter landed early still reads the fleet", async () => {
    const asked: string[] = []
    const earlier = new Date(NOW.getTime() - INTERVAL * 0.8)
    await tick(
      task(
        [go("a")],
        async (account) => {
          asked.push(account.id)
          return { kind: "read" }
        },
        { windows: [{ accountId: "a", lastCheckedAt: earlier }] },
      ),
    )
    expect(asked).toEqual(["a"])
  })
})
