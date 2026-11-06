import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createHealthStore, routableStandIn } from "../../../src/services/dataplane"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import {
  isPlanQuotaReadable,
  type PlanQuotaDeps,
  readPlanQuota,
  selectForPlanQuotaRead,
} from "../../../src/services/models"
import { findSpentWindow } from "../../../src/services/routing"
import { accountRow } from "../../support/account-row"

/**
 * One Account's plan read, against the real health store and a stubbed upstream. The properties that
 * matter are the negative ones: nothing here may cool an account, and nothing here may leak a key.
 */

const NOW = new Date("2026-11-06T12:00:00.000Z")
const RESET = new Date("2026-11-06T15:00:00.000Z").toISOString()
const KEY = "oc_sk_test_plan_quota"

function routable(overrides: Partial<AccountRow> = {}) {
  const row = accountRow({
    id: "acc-1",
    label: "acc-1",
    provider: "opencode-go",
    status: "active",
    authMaterial: KEY,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    ...overrides,
  })
  return routableStandIn(row, {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    dialect: row.dialect,
    modelAliases: row.modelAliases,
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function harness(answer: (request: Request) => Promise<Response>) {
  const health = createHealthStore()
  const seen: Request[] = []
  const deps: PlanQuotaDeps = {
    cipher: { decrypt: (envelope: string) => envelope },
    timeoutMs: 5_000,
    fetch: async (request) => {
      seen.push(request)
      return answer(request)
    },
    health,
    now: () => NOW,
  }
  return { deps, health, seen }
}

const SPENT = {
  usage: {
    rolling: { status: "rate-limited", percent: 100, resetsAt: RESET },
    weekly: { status: "ok", percent: 20, resetsAt: RESET },
    monthly: { status: "ok", percent: 5, resetsAt: RESET },
  },
}

describe("reading a plan's quota, failures first", () => {
  test("403 EntitlementError is a skip, and leaves the account untouched", async () => {
    const { deps, health } = harness(async () =>
      json({ type: "error", error: { type: "EntitlementError", message: "no plan" } }, 403),
    )
    const before = health.stateOf("acc-1")

    expect(await readPlanQuota(deps, routable())).toEqual({
      kind: "skipped",
      reason: "quota:no-plan",
    })
    expect(health.stateOf("acc-1").breaker).toEqual(before.breaker)
    expect(health.stateOf("acc-1").quotaWindows).toEqual([])
  })

  test("a rejected key fails the read and strikes nothing", async () => {
    const { deps, health } = harness(async () => json({ error: { message: "bad key" } }, 401))
    const before = health.stateOf("acc-1").breaker

    const outcome = await readPlanQuota(deps, routable())

    expect(outcome.kind).toBe("failed")
    expect(health.stateOf("acc-1").breaker).toEqual(before)
  })

  test("a failure reason never carries the key, even when the upstream echoes it", async () => {
    const { deps } = harness(async () => json({ error: { message: `bad key ${KEY}` } }, 500))
    const outcome = await readPlanQuota(deps, routable())
    expect(JSON.stringify(outcome)).not.toContain(KEY)
  })

  test("a transport failure is a failed read, never a throw", async () => {
    const { deps } = harness(async () => {
      throw new Error("connect ECONNREFUSED")
    })
    expect((await readPlanQuota(deps, routable())).kind).toBe("failed")
  })

  test("a credential that will not decrypt is a failed read, never a throw", async () => {
    const { deps } = harness(async () => json(SPENT))
    const broken = {
      ...deps,
      cipher: {
        decrypt: () => {
          throw new Error("bad envelope")
        },
      },
    }
    expect((await readPlanQuota(broken, routable())).kind).toBe("failed")
  })

  test("a reshaped answer is a failed read, and installs no reading", async () => {
    const { deps, health } = harness(async () => json({ rolling: 1 }))
    expect(await readPlanQuota(deps, routable())).toEqual({
      kind: "failed",
      reason: "quota:unreadable",
    })
    expect(health.stateOf("acc-1").lastSignalAt).toBeNull()
  })

  test("a provider with no usage endpoint is never asked", async () => {
    const { deps, seen } = harness(async () => json(SPENT))
    const outcome = await readPlanQuota(deps, routable({ provider: "deepseek" }))
    expect(outcome.kind).toBe("skipped")
    expect(seen).toHaveLength(0)
  })

  test("an operator's moved endpoint keeps its key away from the pinned URL", async () => {
    const { deps, seen } = harness(async () => json(SPENT))
    const outcome = await readPlanQuota(deps, routable({ baseUrl: "https://proxy.example/v1" }))
    expect(outcome.kind).toBe("skipped")
    expect(seen).toHaveLength(0)
  })

  test("a reading that outlives a credential change is dropped", async () => {
    const account = routable()
    const { deps, health } = harness(async () => {
      health.reconcile("acc-1", { ...accountHealthFacts(account), authMaterial: "rotated" })
      return json(SPENT)
    })

    await readPlanQuota(deps, account)

    expect(health.stateOf("acc-1").quotaWindows).toEqual([])
  })
})

describe("reading a plan's quota", () => {
  test("a spent window lands on the account and never blocks it", async () => {
    const { deps, health, seen } = harness(async () => json(SPENT))

    expect(await readPlanQuota(deps, routable())).toEqual({ kind: "read" })

    const state = health.stateOf("acc-1")
    expect(state.quotaWindows.map((window) => window.window)).toEqual(["five_hour", "seven_day"])
    expect(state.quotaWindows[0]?.utilization).toBe(1)
    expect(state.limiterWindows.map((window) => window.limiter)).toEqual(["monthly"])
    expect(state.breaker.status).toBe("active")

    const snapshot = { ...routable().snapshot, quotaWindows: state.quotaWindows }
    expect(findSpentWindow(snapshot, NOW)).toBeNull()
    expect(seen[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("the reading reaches the quota writer through the health store's one door", async () => {
    const written: string[][] = []
    const health = createHealthStore({
      onQuotaWindows: (_id, windows) => {
        written.push(windows.map((window) => window.window))
      },
    })
    const { deps } = harness(async () => json(SPENT))

    await readPlanQuota({ ...deps, health }, routable())

    expect(written).toEqual([["five_hour", "seven_day"]])
  })
})

describe("which accounts the sweep asks", () => {
  test("a disabled or dead-key account is not asked; an exhausted one is", () => {
    expect(isPlanQuotaReadable(routable({ status: "disabled" }))).toBe(false)
    expect(isPlanQuotaReadable(routable({ status: "needs_reauth" }))).toBe(false)
    expect(isPlanQuotaReadable(routable({ status: "exhausted" }))).toBe(true)
    expect(isPlanQuotaReadable(routable({ status: "cooling_down" }))).toBe(true)
  })

  test("a provider declaring no read is not a candidate", () => {
    expect(isPlanQuotaReadable(routable({ provider: "deepseek" }))).toBe(false)
  })

  test("an account another replica just read is dropped", () => {
    const due = selectForPlanQuotaRead(
      [{ id: "a" }, { id: "b" }],
      new Map([["a", new Date(NOW.getTime() - 1_000)]]),
      new Map(),
      NOW,
      60_000,
    )
    expect(due.map((account) => account.id)).toEqual(["b"])
  })

  test("a key with no durable stamp still rotates behind the others once looked at", () => {
    const long = new Date(NOW.getTime() - 3_600_000)
    const longer = new Date(NOW.getTime() - 7_200_000)
    const due = selectForPlanQuotaRead(
      [{ id: "no-plan" }, { id: "read" }, { id: "never" }],
      new Map([["read", longer]]),
      new Map([["no-plan", long]]),
      NOW,
      60_000,
    )
    expect(due.map((account) => account.id)).toEqual(["never", "read", "no-plan"])
  })
})
