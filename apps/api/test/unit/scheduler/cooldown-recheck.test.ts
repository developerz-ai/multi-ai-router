import { describe, expect, test } from "bun:test"
import type { AccountStatus, QuotaWindowState } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import type { RateLimitSignal } from "../../../src/providers"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { createCooldownRecheckTask } from "../../../src/scheduler/tasks/cooldown-recheck"
import { createAccountStatusWriter, createHealthStore } from "../../../src/services/dataplane"
import type { RecoveryProbeResult } from "../../../src/services/dataplane/recovery-probe"
import { overlayHealth } from "../../../src/services/dataplane/snapshot"
import type { RoutableAccount } from "../../../src/services/dataplane/types"
import { cooldownRecheckDue, readingReopened } from "../../../src/services/routing/cooldown-recheck"
import { accountRow } from "../../support/account-row"
import { account, at, health, NOW, subscription, window } from "../routing/fixtures"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const spent = (overrides: Partial<QuotaWindowState> = {}) =>
  window("seven_day", {
    utilization: 1,
    utilizationSource: "continuous",
    resetSource: "provider-reported",
    resetsAt: at(3 * DAY),
    ...overrides,
  })

describe("cooldownRecheckDue", () => {
  const due = (snapshot: ReturnType<typeof account>) => cooldownRecheckDue(snapshot, NOW, HOUR, 1)
  const cooling = (until: Date) => ({
    status: "cooling_down" as const,
    health: health({ cooldownUntil: until, cooldownSource: "provider-reported" }),
  })

  test("a cooldown that outlasts the next tick is due", () => {
    expect(due(account("a", cooling(at(3 * DAY))))).toBe(true)
  })

  test("a spent window is due while the row reads active", () => {
    expect(due(account("a", { quotaWindows: [spent()] }))).toBe(true)
  })

  test("a block with no stated end is due: no clock is coming", () => {
    expect(due(account("a", { status: "cooling_down" }))).toBe(true)
    expect(due(account("a", { quotaWindows: [spent({ resetsAt: undefined })] }))).toBe(true)
  })

  test("a reset inside the interval is left to the half-open probe", () => {
    expect(due(account("a", cooling(at(HOUR - 1))))).toBe(false)
  })

  test("the longest block decides", () => {
    expect(due(account("a", { ...cooling(at(60_000)), quotaWindows: [spent()] }))).toBe(true)
  })

  test("a healthy account, and one already half-open, are not", () => {
    expect(due(account("a"))).toBe(false)
    expect(due(account("a", cooling(at(-1))))).toBe(false)
  })

  test.each(["exhausted", "needs_reauth", "disabled"] as const)("%s is never due", (status) => {
    expect(due(account("a", { status, quotaWindows: [spent()] }))).toBe(false)
  })

  test("a refused key keeps its own doubling clock", () => {
    const refused = health({
      cooldownUntil: at(3 * DAY),
      cooldownReason: "credential-rejected",
    })
    expect(due(account("a", { status: "cooling_down", health: refused }))).toBe(false)
  })
})

describe("readingReopened", () => {
  const before = subscription("a", { quotaWindows: [spent()] })
  const fresh = spent({ utilization: 0.1, lastCheckedAt: at(1_000) })

  test("a window re-read below the threshold reopens", () => {
    const after = subscription("a", { quotaWindows: [fresh] })
    expect(readingReopened(before, after, NOW, 1)).toBe(true)
  })

  test("no fresh reading proves nothing, whatever the windows say", () => {
    const stale = subscription("a", { quotaWindows: [spent({ utilization: 0.1 })] })
    expect(readingReopened(before, stale, NOW, 1)).toBe(false)
    const none = subscription("a")
    expect(readingReopened(none, none, NOW, 1)).toBe(false)
  })

  test("a fresh reading that is still spent does not", () => {
    const after = subscription("a", { quotaWindows: [spent({ lastCheckedAt: at(1_000) })] })
    expect(readingReopened(before, after, NOW, 1)).toBe(false)
  })
})

function routable(
  id: string,
  provider: string,
  status: AccountStatus = "active",
  quotaWindows: readonly QuotaWindowState[] = [],
) {
  return {
    id,
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authMaterial: "cipher",
    driver: { provider },
    snapshot: account(id, {
      provider: provider as ReturnType<typeof account>["provider"],
      status,
      supportedModels: ["declared-model"],
      quotaWindows: [...quotaWindows],
    }),
  } as unknown as RoutableAccount
}

function harness(
  accounts: readonly RoutableAccount[],
  answer: () => RecoveryProbeResult = () => ({ kind: "answered", ok: true, message: "" }),
  options: { reading?: RateLimitSignal; batchSize?: number } = {},
) {
  const blocked: { accountId: string; status: AccountStatus }[] = []
  const store = createHealthStore({
    jitter: () => 0,
    onBlocked: (accountId, status, observation) => {
      if (observation !== undefined) blocked.push({ accountId, status })
    },
  })
  const sent: { accountId: string; model: string; trigger?: string }[] = []
  const rechecked: string[] = []
  const rows = new Map<string, AccountRow>(
    accounts.map((held) => [
      held.id,
      accountRow({
        id: held.id,
        provider: held.snapshot.provider as AccountRow["provider"],
        status: held.snapshot.status,
      }),
    ]),
  )
  const hooks: { usage?: () => Promise<"read" | "no_cli" | "cold"> } = {}
  const task = createCooldownRecheckTask({
    accounts: () => accounts,
    snapshot: (id) => {
      const held = accounts.find((candidate) => candidate.id === id)
      return held === undefined ? undefined : overlayHealth(held.snapshot, store.stateOf(id))
    },
    rows: { findById: async (id) => rows.get(id) },
    health: store,
    send: async ({ accountId, model, rateLimitSink, trigger }) => {
      sent.push({ accountId, model, ...(trigger === undefined ? {} : { trigger }) })
      if (options.reading !== undefined) rateLimitSink(options.reading)
      return answer()
    },
    startGuard: () => async () => undefined,
    usage: async () => (hooks.usage === undefined ? "read" : hooks.usage()),
    models: {},
    quotaSpentThreshold: 1,
    intervalMs: HOUR,
    batchSize: options.batchSize ?? 5,
    recheckExhausted: async (accountId) => {
      rechecked.push(accountId)
      return "rechecked" as const
    },
    exhaustedSchedule: { firstMs: HOUR, maxMs: DAY },
  })
  const run = (signal = new AbortController().signal) =>
    task.run({
      now: NOW,
      logger: createLogger({ level: "error", write: () => undefined }),
      signal,
    })
  const cool = (id: string, resetsAt = at(3 * DAY)) =>
    store.recordFailure(id, { kind: "rate-limited", resetsAt, message: "limit" }, NOW)
  return { store, sent, blocked, run, cool, hooks, rechecked }
}

describe("the cooldown_recheck task", () => {
  const limited: RecoveryProbeResult = {
    kind: "answered",
    ok: false,
    failureKind: "rate-limited",
    message: "http-status:429",
  }

  test("one real request per account per tick, and a success ends the cooldown", async () => {
    const h = harness([routable("a", "openai-oauth")])
    h.cool("a")

    const result = await h.run()

    expect(h.sent).toEqual([
      { accountId: "a", model: "declared-model", trigger: "cooldown_recheck" },
    ])
    expect(result).toEqual({ outcome: "success", itemsProcessed: 1 })
    expect(h.store.stateOf("a").breaker.status).toBe("active")
  })

  test.each([
    ["no reset at all", { limited: true, resetSource: "unknown", windows: [] }],
    [
      "a shorter reset",
      { limited: true, resetSource: "provider-reported", windows: [], retryAfterSeconds: 60 },
    ],
    [
      "a later reset",
      { limited: true, resetSource: "provider-reported", windows: [], resetsAt: at(9 * DAY) },
    ],
  ] as const)("a 429 reading %s leaves the stated reset intact", async (_name, reading) => {
    const h = harness([routable("a", "openai-oauth")], () => limited, {
      reading: reading as unknown as RateLimitSignal,
    })
    h.cool("a")
    const before = h.store.stateOf("a").breaker

    await h.run()

    expect(h.store.stateOf("a").breaker).toEqual(before)
    expect(h.store.stateOf("a").breaker.cooldownUntil).toEqual(at(3 * DAY))
  })

  // 10.8 (prod, opencode-go 589105ca / ae852ac0): `seven_day utilization=1.000`, provider-reported
  // reset days out — and `verdict=reopened` 26 times in 37.5 h, each followed by real 429s. The
  // probe model is not the one the weekly limit is charged to, so its 2xx proves nothing about it.
  test("a 2xx probe does not reopen a seat whose provider-reported window is still spent", async () => {
    const h = harness([routable("a", "openai-oauth", "active", [spent()])])
    h.cool("a")
    const before = h.store.stateOf("a").breaker

    const result = await h.run()

    expect(h.sent).toHaveLength(1)
    expect(h.store.stateOf("a").breaker).toEqual(before)
    expect(result).toEqual({ outcome: "success", itemsProcessed: 1 })
  })

  test("a 2xx probe whose own reading re-reads the window open does reopen", async () => {
    const h = harness([routable("a", "openai-oauth", "active", [spent()])], undefined, {
      reading: {
        limited: false,
        resetSource: "provider-reported",
        windows: [],
        quotaWindows: [spent({ utilization: 0.2, lastCheckedAt: at(1_000) })],
      },
    })
    h.cool("a")

    await h.run()

    expect(h.store.stateOf("a").breaker.status).toBe("active")
  })

  test("a 429 with no reading at all leaves it intact too", async () => {
    const h = harness([routable("a", "openai-oauth")], () => limited)
    h.cool("a")
    const before = h.store.stateOf("a").breaker

    await h.run()

    expect(h.store.stateOf("a").breaker).toEqual(before)
  })

  test("a 429's window readings still land", async () => {
    const h = harness([routable("a", "openai-oauth")], () => limited, {
      reading: {
        limited: true,
        resetSource: "unknown",
        windows: [{ limiter: "x", utilizationSource: "continuous", resetSource: "unknown" }],
      },
    })
    h.cool("a")

    await h.run()

    expect(h.store.stateOf("a").limiterWindows).toHaveLength(1)
  })

  const refused = (failureKind: "credits-exhausted" | "auth" | "invalid-request") => () =>
    ({
      kind: "answered",
      ok: false,
      failureKind,
      message: "upstream refused",
    }) as const

  test("an out-of-credits answer is exhausted, and leaves this lane for the bounded re-test", async () => {
    const h = harness([routable("a", "openai-oauth")], refused("credits-exhausted"))
    h.cool("a")

    for (let tick = 0; tick < 4; tick++) await h.run()

    // No request of this lane's own, ever; the re-test is "Re-check now", an hour on at the soonest.
    expect(h.sent).toHaveLength(1)
    expect(h.rechecked).toEqual([])
    expect(h.store.stateOf("a").breaker.status).toBe("exhausted")
    expect(h.store.stateOf("a").breaker.cooldownUntil).toBeUndefined()
    expect(h.blocked).toEqual([{ accountId: "a", status: "exhausted" }])
  })

  test("a 401 on an OAuth account parks it, so its one refresh actually runs", async () => {
    const h = harness([routable("a", "openai-oauth")], refused("auth"))
    h.cool("a")

    for (let tick = 0; tick < 3; tick++) await h.run()

    expect(h.sent).toHaveLength(1)
    expect(h.store.stateOf("a").breaker.status).toBe("needs_reauth")
    expect(h.blocked).toEqual([{ accountId: "a", status: "needs_reauth" }])
  })

  test("a 401 on an API key takes the credential-rejected clock, not a park", async () => {
    const h = harness([routable("a", "openai-api")], refused("auth"))
    h.cool("a")

    for (let tick = 0; tick < 3; tick++) await h.run()

    expect(h.sent).toHaveLength(1)
    expect(h.store.stateOf("a").breaker.cooldownReason).toBe("credential-rejected")
    expect(h.store.stateOf("a").breaker.cooldownUntil).toEqual(at(3 * DAY))
    expect(h.blocked).toEqual([])
  })

  test("a 5xx counts against the streak and leaves a longer stated reset standing", async () => {
    const h = harness([routable("a", "openai-oauth")], () => ({
      kind: "answered",
      ok: false,
      failureKind: "server-error",
      message: "http-status:503",
    }))
    h.cool("a")

    await h.run()

    expect(h.store.stateOf("a").breaker.status).toBe("cooling_down")
    expect(h.store.stateOf("a").breaker.cooldownUntil).toEqual(at(3 * DAY))
    expect(h.store.stateOf("a").breaker.cooldownSource).toBe("provider-reported")
  })

  test("the parked verdict reaches the status writer, whose commit starts the refresh", async () => {
    const parked: string[] = []
    const writer = createAccountStatusWriter({
      accounts: {
        transitionObservedStatus: async ({ id, status }) => accountRow({ id, status }),
      },
      logger: createLogger({ level: "error", write: () => undefined }),
      flushIntervalMs: 1_000,
      now: () => NOW,
    })
    writer.attachParked((id) => parked.push(id))
    const held = routable("a", "openai-oauth")
    const store = createHealthStore({
      jitter: () => 0,
      onBlocked: (id, status, observation) => {
        if (observation !== undefined) writer.record(id, status, observation)
      },
    })
    store.recordFailure("a", { kind: "rate-limited", resetsAt: at(3 * DAY), message: "limit" }, NOW)
    const task = createCooldownRecheckTask({
      accounts: () => [held],
      snapshot: () => overlayHealth(held.snapshot, store.stateOf("a")),
      rows: { findById: async () => accountRow({ id: "a" }) },
      health: store,
      send: async () => refused("auth")(),
      startGuard: () => async () => undefined,
      models: {},
      quotaSpentThreshold: 1,
      intervalMs: HOUR,
      batchSize: 5,
      recheckExhausted: async () => "rechecked" as const,
      exhaustedSchedule: { firstMs: HOUR, maxMs: DAY },
    })

    await task.run({
      now: NOW,
      logger: createLogger({ level: "error", write: () => undefined }),
      signal: new AbortController().signal,
    })
    await writer.flush()

    expect(parked).toEqual(["a"])
  })

  test("a refused ping says nothing about the account", async () => {
    const h = harness([routable("a", "openai-oauth")], refused("invalid-request"))
    h.cool("a")
    const before = h.store.stateOf("a").breaker

    await h.run()

    expect(h.store.stateOf("a").breaker).toEqual(before)
  })

  test.each(["exhausted", "needs_reauth", "disabled"] as const)(
    "a stored %s is never sent anything",
    async (status) => {
      const h = harness([routable("a", "openai-oauth", status)])
      h.cool("a")

      expect(await h.run()).toEqual({ outcome: "success", itemsProcessed: 0 })
      expect(h.sent).toEqual([])
    },
  )

  test("an exhausted verdict held only in memory is never sent anything", async () => {
    const h = harness([routable("a", "openai-oauth")])
    h.store.recordFailure("a", { kind: "credits-exhausted", message: "drained" }, NOW)

    await h.run()

    expect(h.sent).toEqual([])
    expect(h.store.stateOf("a").breaker.status).toBe("exhausted")
  })

  test("a declined admission is a skip: nothing was sent, nothing moves", async () => {
    const h = harness([routable("a", "openai-oauth")], () => ({ kind: "declined" }))
    h.cool("a")
    const before = h.store.stateOf("a").breaker

    expect(await h.run()).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(h.store.stateOf("a").breaker).toEqual(before)
  })

  test("a batch smaller than the pool rotates instead of starving the tail", async () => {
    const h = harness(
      [routable("a", "openai-oauth"), routable("b", "openai-oauth")],
      () => limited,
      {
        batchSize: 1,
      },
    )
    h.cool("a")
    h.cool("b")

    const first = await h.run()
    await h.run()

    expect(first.outcome).toBe("partial")
    expect(h.sent.map((call) => call.accountId)).toEqual(["a", "b"])
  })

  test("shutdown stops it between accounts", async () => {
    const h = harness([routable("a", "openai-oauth")])
    h.cool("a")
    const stopping = new AbortController()
    stopping.abort()

    expect((await h.run(stopping.signal)).outcome).toBe("partial")
    expect(h.sent).toEqual([])
  })

  describe("a Claude subscription", () => {
    const claude = () => routable("a", "anthropic-oauth")

    test("is never sent a request: the read is turn-free", async () => {
      const h = harness([claude()])
      h.cool("a")

      await h.run()

      expect(h.sent).toEqual([])
    })

    test("a read that finds the window open ends the cooldown", async () => {
      const h = harness([claude()])
      h.cool("a")
      h.hooks.usage = async () => {
        h.store.applyRateLimit(
          "a",
          {
            limited: false,
            resetSource: "provider-reported",
            windows: [],
            quotaWindows: [spent({ utilization: 0.1, lastCheckedAt: at(1_000) })],
          },
          NOW,
        )
        return "read"
      }

      await h.run()

      expect(h.store.stateOf("a").breaker.status).toBe("active")
    })

    test("a read that produced no reading leaves the cooldown standing", async () => {
      const h = harness([claude()])
      h.cool("a")
      const before = h.store.stateOf("a").breaker

      await h.run()

      expect(h.store.stateOf("a").breaker).toEqual(before)
    })

    test("a cold credential is left alone: no turn is spent to warm it here", async () => {
      const h = harness([claude()])
      h.cool("a")
      h.hooks.usage = async () => "cold"

      expect(await h.run()).toEqual({ outcome: "success", itemsProcessed: 0 })
      expect(h.sent).toEqual([])
    })

    test("a read refused at admission is a skip, not a failure", async () => {
      const h = harness([claude()])
      h.cool("a")
      h.hooks.usage = async () => {
        throw new UpstreamAdmissionRefused("background account is not ordinarily eligible")
      }

      expect(await h.run()).toEqual({ outcome: "success", itemsProcessed: 0 })
    })
  })
})
