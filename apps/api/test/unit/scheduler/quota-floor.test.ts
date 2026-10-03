import { describe, expect, test } from "bun:test"
import type { AccountRow, QuotaWindowRow } from "@multi-ai-router/db"
import { createQuotaFloorTask, type QuotaFloorDeps } from "../../../src/scheduler/tasks/quota-floor"
import { HEALTHY } from "../../../src/services/routing"
import { accountRow as durableAccountRow } from "../../support/account-row"
import { NOW, silentLogger } from "./fixtures"

/**
 * `createQuotaFloorTask` clears an idle account's *expired* quota reading —
 * never fetches a fresh one, never touches an account traffic is still
 * reaching, and never touches a row with no reset to expire (`exhausted`).
 * These pin the three predicates the task's doc comment claims: idle is
 * "no live signal within one floor interval", expired is "the window's own
 * `resetsAt` has passed", and clearing writes `none`/`unknown`, never a zero.
 */

const IDLE_AFTER_MS = 60 * 60 * 1000 // one hour, matching the interval below
const INTERVAL_MS = IDLE_AFTER_MS

function account(id: string): AccountRow {
  return durableAccountRow({
    id,
    label: id,
    provider: "anthropic-oauth",
    status: "active",
    authMaterial: null,
    configDir: null,
    tokenExpiresAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function window(accountId: string, overrides: Partial<QuotaWindowRow> = {}): QuotaWindowRow {
  return {
    revision: 0,
    retiredAt: null,
    id: crypto.randomUUID(),
    accountId,
    window: "five_hour",
    utilization: 0.9,
    utilizationSource: "continuous",
    resetsAt: new Date(NOW.getTime() - 1),
    resetSource: "provider-reported",
    lastCheckedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    createdAt: NOW,
    ...overrides,
  }
}

interface FakeRepo {
  readonly accounts: AccountRow[]
  readonly windows: QuotaWindowRow[]
  readonly upserts: Array<{ accountId: string; state: Record<string, unknown> }>
}

function fakeRepo(
  accounts: AccountRow[],
  windows: QuotaWindowRow[],
): FakeRepo & {
  deps: Pick<QuotaFloorDeps, "accounts">["accounts"]
} {
  const upserts: FakeRepo["upserts"] = []
  return {
    accounts,
    windows,
    upserts,
    deps: {
      list: async () => accounts,
      listQuotaWindows: async (ids) => windows.filter((w) => ids.includes(w.accountId)),
      clearObservedQuotaWindow: async ({ accountId, window: kind, expected, now }) => {
        const existing = windows.find((w) => w.accountId === accountId && w.window === kind)
        if (
          existing === undefined ||
          existing.revision !== expected.revision ||
          existing.resetsAt?.getTime() !== expected.resetsAt.getTime() ||
          expected.resetsAt > now
        )
          return undefined
        const next: QuotaWindowRow = {
          ...existing,
          revision: existing.revision + 1,
          retiredAt: now,
          utilization: null,
          utilizationSource: "none",
          resetsAt: null,
          resetSource: "unknown",
        }
        upserts.push({ accountId, state: next as unknown as Record<string, unknown> })
        windows[windows.indexOf(existing)] = next
        return next
      },
    },
  }
}

function fakeHealth(lastSignalAt: Record<string, Date | null>) {
  return {
    stateOf: (accountId: string) => ({
      breaker: HEALTHY,
      inFlight: 0,
      recentTokens: 0,
      limiterWindows: [],
      lastSignalAt: lastSignalAt[accountId] ?? null,
    }),
  }
}

function run(task: ReturnType<typeof createQuotaFloorTask>) {
  return task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal })
}

describe("the quota floor", () => {
  test("clears an expired reading on an idle account to none/unknown, not a zero", async () => {
    const a = account("a1")
    const repo = fakeRepo([a], [window("a1")])
    const task = createQuotaFloorTask({
      accounts: repo.deps,
      health: fakeHealth({}), // never signalled: idle
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const result = await run(task)

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(1)
    expect(repo.upserts).toHaveLength(1)
    const written = repo.upserts[0]?.state
    expect(written?.utilizationSource).toBe("none")
    expect(written?.resetSource).toBe("unknown")
    expect(written?.lastCheckedAt).toEqual(new Date(NOW.getTime() - 2 * 60 * 60 * 1000))
    expect(repo.windows[0]?.utilization).toBeNull()
  })

  test("an account traffic just reached is left untouched even with an expired window", async () => {
    const a = account("a1")
    const repo = fakeRepo([a], [window("a1")])
    const task = createQuotaFloorTask({
      accounts: repo.deps,
      health: fakeHealth({ a1: new Date(NOW.getTime() - 1_000) }), // signalled a second ago
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const result = await run(task)

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(0)
    expect(repo.upserts).toHaveLength(0)
  })

  test("an idle account whose reset has not passed yet is left alone", async () => {
    const a = account("a1")
    const repo = fakeRepo([a], [window("a1", { resetsAt: new Date(NOW.getTime() + 60_000) })])
    const task = createQuotaFloorTask({
      accounts: repo.deps,
      health: fakeHealth({}),
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const result = await run(task)

    expect(result.itemsProcessed).toBe(0)
    expect(repo.upserts).toHaveLength(0)
  })

  test("an exhausted account (null resetsAt) never matches and is never touched", async () => {
    const a = account("a1")
    const repo = fakeRepo([a], [window("a1", { resetsAt: null, utilizationSource: "none" })])
    const task = createQuotaFloorTask({
      accounts: repo.deps,
      health: fakeHealth({}),
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const result = await run(task)

    expect(result.itemsProcessed).toBe(0)
    expect(repo.upserts).toHaveLength(0)
  })

  test("an account never seen at all counts as idle", async () => {
    const a = account("a1")
    const repo = fakeRepo([a], [window("a1")])
    const task = createQuotaFloorTask({
      accounts: repo.deps,
      health: fakeHealth({ a1: null }),
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const result = await run(task)

    expect(result.itemsProcessed).toBe(1)
  })

  test("a second run against an already-cleared window is a no-op", async () => {
    const a = account("a1")
    const repo = fakeRepo([a], [window("a1")])
    const task = createQuotaFloorTask({
      accounts: repo.deps,
      health: fakeHealth({}),
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const first = await run(task)
    expect(first.itemsProcessed).toBe(1)

    const second = await run(task)
    expect(second.itemsProcessed).toBe(0)
  })

  test("a shutdown mid-drain reports partial and the next tick finishes it", async () => {
    const a1 = account("a1")
    const a2 = account("a2")
    const repo = fakeRepo([a1, a2], [window("a1"), window("a2")])
    const controller = new AbortController()
    let calls = 0
    const upsertOriginal = repo.deps.clearObservedQuotaWindow
    const deps: QuotaFloorDeps["accounts"] = {
      ...repo.deps,
      clearObservedQuotaWindow: async (input) => {
        calls += 1
        const row = await upsertOriginal(input)
        if (calls === 1) controller.abort()
        return row
      },
    }
    const task = createQuotaFloorTask({
      accounts: deps,
      health: fakeHealth({}),
      intervalMs: INTERVAL_MS,
      idleAfterMs: IDLE_AFTER_MS,
    })

    const partial = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })
    expect(partial.outcome).toBe("partial")
    expect(partial.itemsProcessed).toBe(1)

    const resume = await run(task)
    expect(resume.outcome).toBe("success")
    expect(resume.itemsProcessed).toBe(1)
  })
})

test("floor CAS miss does not count or clear a concurrently fresh provider window", async () => {
  const repo = fakeRepo([account("a1")], [window("a1")])
  const clear = repo.deps.clearObservedQuotaWindow
  const task = createQuotaFloorTask({
    accounts: {
      ...repo.deps,
      clearObservedQuotaWindow: async (input) => {
        repo.windows[0] = window("a1", {
          revision: 1,
          utilization: 1,
          resetsAt: new Date(NOW.getTime() + 10000),
        })
        return clear(input)
      },
    },
    health: fakeHealth({}),
    intervalMs: INTERVAL_MS,
    idleAfterMs: IDLE_AFTER_MS,
  })
  const result = await run(task)
  expect(result.itemsProcessed).toBe(0)
  expect(repo.upserts).toHaveLength(0)
  expect(repo.windows[0]?.utilization).toBe(1)
})

test("permanent exhausted status is untouched even with an expired stored reset", async () => {
  const repo = fakeRepo([{ ...account("a1"), status: "exhausted" }], [window("a1")])
  const task = createQuotaFloorTask({
    accounts: repo.deps,
    health: fakeHealth({}),
    intervalMs: INTERVAL_MS,
    idleAfterMs: IDLE_AFTER_MS,
  })
  expect(
    (await task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal }))
      .itemsProcessed,
  ).toBe(0)
  expect(repo.upserts).toHaveLength(0)
})
