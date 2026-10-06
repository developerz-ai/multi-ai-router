/**
 * Candidate filtering. An account survives only if all five rules hold, and every drop is
 * recorded with the reason that produced it — the error the caller renders depends on it.
 */

import { describe, expect, test } from "bun:test"
import type { AccountSnapshot, FilterReason, RecoverySnapshot } from "../../../src/services/routing"
import { filterCandidates, resolveModel } from "../../../src/services/routing"
import { account, at, continuous, health, NOW, scoped, window } from "./fixtures"

const run = (accounts: readonly AccountSnapshot[], model = "sonnet", now = NOW) =>
  filterCandidates(
    accounts.map((entry, order) => scoped(entry, order)),
    model,
    now,
  )

describe("status", () => {
  const cases: readonly [string, AccountSnapshot, FilterReason][] = [
    ["disabled", account("a", { status: "disabled" }), "disabled"],
    ["needs_reauth", account("a", { status: "needs_reauth" }), "needs-reauth"],
    ["exhausted", account("a", { status: "exhausted" }), "exhausted"],
    [
      "cooling_down",
      account("a", { status: "cooling_down", health: health({ cooldownUntil: at(60_000) }) }),
      "cooling-down",
    ],
  ]

  test.each(cases)("%s is dropped", (_name, entry, reason) => {
    const result = run([entry])
    expect(result.eligible).toHaveLength(0)
    expect(result.rejected[0]?.reason).toBe(reason)
  })

  test("an active account survives", () => {
    expect(run([account("a")]).eligible.map((c) => c.account.id)).toEqual(["a"])
  })

  test("`exhausted` carries no reset — that absence is what it means", () => {
    const rejected = run([account("a", { status: "exhausted" })]).rejected[0]
    expect(rejected?.resetsAt).toBeUndefined()
  })

  test("a cooldown carries its instant and how trustworthy it is", () => {
    const rejected = run([
      account("a", {
        status: "cooling_down",
        health: health({ cooldownUntil: at(60_000), cooldownSource: "provider-reported" }),
      }),
    ]).rejected[0]

    expect(rejected?.resetsAt).toEqual(at(60_000))
    expect(rejected?.resetSource).toBe("provider-reported")
  })
})

describe("the breaker's half-open probe", () => {
  test("a cooldown whose instant has passed comes back, labeled a probe", () => {
    const probe = account("a", {
      status: "cooling_down",
      health: health({ cooldownUntil: at(-1_000) }),
    })
    const result = run([probe])

    expect(result.eligible[0]?.halfOpen).toBe(true)
  })

  test("a `cooling_down` account with no recorded instant stays out — no number is invented", () => {
    const result = run([account("a", { status: "cooling_down" })])
    expect(result.eligible).toHaveLength(0)
    expect(result.rejected[0]?.resetsAt).toBeUndefined()
  })

  test("an active account whose breaker instant is still ahead is cooling down", () => {
    const result = run([account("a", { health: health({ cooldownUntil: at(30_000) }) })])
    expect(result.rejected[0]?.reason).toBe("cooling-down")
  })
})

describe("exactly one probe — the gate, not the label", () => {
  const probe = (overrides: Parameters<typeof health>[0] = {}) =>
    account("a", {
      status: "cooling_down",
      health: health({ cooldownUntil: at(-1_000), ...overrides }),
    })

  test("a probe another request already holds is dropped, not handed out a second time", () => {
    const result = run([probe({ probeHeldUntil: at(20_000) })])

    expect(result.eligible).toHaveLength(0)
    expect(result.rejected[0]?.reason).toBe("probe-in-flight")
  })

  test("the drop carries the hold's expiry, labeled as the router's own arithmetic", () => {
    const rejected = run([probe({ probeHeldUntil: at(20_000) })]).rejected[0]

    expect(rejected?.resetsAt).toEqual(at(20_000))
    // Never `provider-reported`: no provider said anything about this instant.
    expect(rejected?.resetSource).toBe("estimated")
  })

  test("a hold that has expired lets the next request probe — a lost probe parks nothing", () => {
    const result = run([probe({ probeHeldUntil: at(-1) })])

    expect(result.eligible[0]?.halfOpen).toBe(true)
  })

  test("the hold never outranks the cooldown it sits inside", () => {
    // Still cooling: the account is not recovering yet, so the honest reason is the cooldown and
    // the reset the provider reported — not a gate that has no bearing on it.
    const result = run([
      account("a", {
        status: "cooling_down",
        health: health({ cooldownUntil: at(60_000), probeHeldUntil: at(20_000) }),
      }),
    ])

    expect(result.rejected[0]?.reason).toBe("cooling-down")
    expect(result.rejected[0]?.resetsAt).toEqual(at(60_000))
  })

  test("a healthy account is never gated, whatever stale hold it carries", () => {
    const result = run([account("a", { health: health({ probeHeldUntil: at(20_000) }) })])

    expect(result.eligible.map((c) => c.account.id)).toEqual(["a"])
    expect(result.eligible[0]?.halfOpen).toBe(false)
  })
})

describe("quota headroom", () => {
  test("a spent window drops the account and names the window", () => {
    const spent = account("a", { quotaWindows: [continuous(1, "seven_day_opus")] })
    const rejected = run([spent]).rejected[0]

    expect(rejected?.reason).toBe("quota-window-spent")
    expect(rejected?.window).toBe("seven_day_opus")
  })

  test("a threshold-triggered alarm at the limit blocks just as well as a continuous one", () => {
    const spent = account("a", {
      quotaWindows: [
        window("five_hour", { utilization: 1, utilizationSource: "threshold-triggered" }),
      ],
    })
    expect(run([spent]).rejected[0]?.reason).toBe("quota-window-spent")
  })

  test("a window whose reset has already passed has refilled", () => {
    const refilled = account("a", {
      quotaWindows: [
        window("five_hour", {
          utilization: 1,
          utilizationSource: "continuous",
          resetsAt: at(-1),
          resetSource: "provider-reported",
        }),
      ],
    })
    expect(run([refilled]).eligible).toHaveLength(1)
  })

  test("an absent utilization reading is not a spent window", () => {
    const unknown = account("a", { quotaWindows: [window("five_hour")] })
    expect(run([unknown]).eligible).toHaveLength(1)
  })
})

describe("model support", () => {
  test("an account with no declared model set supports everything", () => {
    expect(run([account("a")], "some-model-nobody-has-heard-of").eligible).toHaveLength(1)
  })

  test("a declared set that omits the model drops the account", () => {
    const narrow = account("a", { supportedModels: ["opus"] })
    expect(run([narrow], "sonnet").rejected[0]?.reason).toBe("model-unsupported")
  })

  test("support is judged after alias mapping", () => {
    const aliased = account("a", {
      modelAliases: { sonnet: "glm-4.7" },
      supportedModels: ["glm-4.7"],
    })
    const result = run([aliased], "sonnet")

    expect(result.eligible[0]?.upstreamModel).toBe("glm-4.7")
  })

  test("the upstream name is the client's unless an alias renamed it", () => {
    expect(resolveModel(account("a"), "sonnet")).toEqual({
      upstreamModel: "sonnet",
      supported: true,
      aliased: false,
    })
  })
})

describe("ordering of reasons", () => {
  test("status wins over quota, so a disabled account is not reported as rate limited", () => {
    const both = account("a", {
      status: "disabled",
      quotaWindows: [continuous(1)],
    })
    expect(run([both]).rejected[0]?.reason).toBe("disabled")
  })
})

describe("a credential the provider rejected", () => {
  const rejectedKey = (until: Date) =>
    account("kimi", {
      status: "cooling_down",
      health: health({
        cooldownUntil: until,
        cooldownSource: "estimated",
        cooldownReason: "credential-rejected",
      }),
    })

  test("is dropped as credential-rejected, never as the operator's `disabled`", () => {
    const result = run([rejectedKey(at(60_000))])

    expect(result.eligible).toHaveLength(0)
    expect(result.rejected[0]).toMatchObject({
      reason: "credential-rejected",
      resetsAt: at(60_000),
      resetSource: "estimated",
    })
  })

  test("comes back as a half-open probe once its cooldown passes", () => {
    const result = run([rejectedKey(at(-1))])
    expect(result.eligible.map((candidate) => candidate.halfOpen)).toEqual([true])
  })
})

describe("a recovery gate never hides a provider-reported clock", () => {
  const providerReset = at(2 * 24 * 60 * 60_000)
  const gated = (overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot => ({
    state: "issued",
    localAvailable: false,
    retryAt: at(30_000),
    revision: 1,
    generation: "g1",
    lifecycleVersion: 1,
    nextAllowedAt: at(30_000),
    quotaRevisions: {},
    ...overrides,
  })
  const spentWeek = window("seven_day", {
    utilization: 1,
    utilizationSource: "continuous",
    resetsAt: providerReset,
    resetSource: "provider-reported",
    revision: 3,
  })

  test("a spent provider-reported window on a recovery-gated account reports the window, not the probe", () => {
    const result = run([account("venom", { quotaWindows: [spentWeek], recovery: gated() })])

    expect(result.eligible).toHaveLength(0)
    expect(result.rejected[0]).toMatchObject({
      reason: "quota-window-spent",
      window: "seven_day",
      resetsAt: providerReset,
      resetSource: "provider-reported",
    })
  })

  test("a spent provider-reported window outranks the breaker's probe hold too", () => {
    const halfOpen = account("venom", {
      status: "cooling_down",
      quotaWindows: [spentWeek],
      health: health({ cooldownUntil: at(-1), probeHeldUntil: at(30_000) }),
    })
    expect(run([halfOpen]).rejected[0]).toMatchObject({
      reason: "quota-window-spent",
      resetsAt: providerReset,
    })
  })

  test("a provider-reported cooldown on a recovery-gated account reports the provider's instant", () => {
    const limited = account("dev", {
      status: "cooling_down",
      health: health({ cooldownUntil: at(600_000), cooldownSource: "provider-reported" }),
      recovery: gated(),
    })
    expect(run([limited]).rejected[0]).toMatchObject({
      reason: "cooling-down",
      resetsAt: at(600_000),
      resetSource: "provider-reported",
    })
  })

  test("a spent window with no known reset stays behind the gate — the probe is its only clock", () => {
    const stale = window("seven_day", { utilization: 1, utilizationSource: "continuous" })
    expect(
      run([account("venom", { quotaWindows: [stale], recovery: gated() })]).rejected[0],
    ).toMatchObject({ reason: "probe-in-flight", resetsAt: at(30_000), resetSource: "estimated" })
  })

  test("the permit holder still probes past the exact evidence it captured", () => {
    const permit = gated({ localAvailable: true, quotaRevisions: { seven_day: 3 } })
    const result = run([account("venom", { quotaWindows: [spentWeek], recovery: permit })])
    expect(result.eligible.map((candidate) => candidate.halfOpen)).toEqual([true])
  })
})
