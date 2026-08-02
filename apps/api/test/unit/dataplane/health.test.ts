import { describe, expect, test } from "bun:test"
import type { AccountStatus, QuotaWindowState } from "@multi-ai-router/core"
import type { RateLimitSignal } from "../../../src/providers"
import { buildSnapshot, createHealthStore, overlayHealth } from "../../../src/services/dataplane"
import { account, catalog, NOW } from "./fixtures"

/**
 * The health snapshot the pure selection functions read.
 *
 * The invariant that matters most: `cooling_down` and `exhausted` are never conflated. One carries
 * a reset instant a clock will pass; the other carries none, by definition, so nothing can retry it
 * on a timer.
 */

function signal(overrides: Partial<RateLimitSignal> = {}): RateLimitSignal {
  return { limited: false, resetSource: "unknown", windows: [], ...overrides }
}

describe("health store", () => {
  test("a fresh account is healthy and in no cooldown", () => {
    const store = createHealthStore()
    expect(store.stateOf("a").breaker.status).toBe("active")
  })

  test("a rate limit cools the account down until its reported reset", () => {
    const store = createHealthStore()
    const resetsAt = new Date(NOW.getTime() + 60_000)

    store.recordFailure(
      "a",
      { kind: "rate-limited", resetsAt, resetSource: "provider-reported", message: "429" },
      NOW,
    )

    const state = store.stateOf("a")
    expect(state.breaker.status).toBe("cooling_down")
    expect(state.breaker.cooldownUntil).toEqual(resetsAt)
    expect(state.breaker.cooldownSource).toBe("provider-reported")
  })

  test("out of credits is exhausted, with no reset — no timer can clear it", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    const state = store.stateOf("a")
    expect(state.breaker.status).toBe("exhausted")
    expect(state.breaker.cooldownUntil).toBeUndefined()
  })

  test("an auth failure needs a human: reauth for OAuth, disabled for a key", () => {
    const store = createHealthStore()
    store.recordFailure("oauth", { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })
    store.recordFailure("key", { kind: "auth", message: "401" }, NOW, { authKind: "api-key" })

    expect(store.stateOf("oauth").breaker.status).toBe("needs_reauth")
    expect(store.stateOf("key").breaker.status).toBe("disabled")
  })

  test("a reported limit on an otherwise fine response still cools the account down", () => {
    const store = createHealthStore()
    const resetsAt = new Date(NOW.getTime() + 30_000)

    store.applyRateLimit(
      "a",
      signal({ limited: true, resetsAt, resetSource: "provider-reported" }),
      NOW,
    )

    expect(store.stateOf("a").breaker.status).toBe("cooling_down")
  })

  test("a limited header never downgrades exhausted — a dead balance is not a cooldown", () => {
    const store = createHealthStore()
    // The common shape: a 402 whose response still carries `x-ratelimit-remaining-requests: 0`.
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)
    store.applyRateLimit(
      "a",
      signal({
        limited: true,
        resetsAt: new Date(NOW.getTime() + 60_000),
        resetSource: "provider-reported",
      }),
      NOW,
    )

    const state = store.stateOf("a")
    expect(state.breaker.status).toBe("exhausted")
    expect(state.breaker.cooldownUntil).toBeUndefined()
  })

  test("a limited header never downgrades needs_reauth or disabled", () => {
    const store = createHealthStore()
    store.recordFailure("oauth", { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })
    store.recordFailure("key", { kind: "auth", message: "401" }, NOW, { authKind: "api-key" })

    const limited = signal({
      limited: true,
      retryAfterSeconds: 30,
      resetSource: "provider-reported",
    })
    store.applyRateLimit("oauth", limited, NOW)
    store.applyRateLimit("key", limited, NOW)

    expect(store.stateOf("oauth").breaker.status).toBe("needs_reauth")
    expect(store.stateOf("oauth").breaker.cooldownUntil).toBeUndefined()
    expect(store.stateOf("key").breaker.status).toBe("disabled")
    expect(store.stateOf("key").breaker.cooldownUntil).toBeUndefined()
  })

  test("a concurrent 429 never demotes exhausted back to cooling_down", () => {
    // Two attempts in flight on the same account: one answers 402, the other 429 a moment later.
    // `foldRateLimit` already refused the header's version of this; the classified-failure path
    // had no such guard, so the late 429 rewrote "top this account up" as "retry at 14:32" and
    // put a dead balance back on the half-open probe's timer (non-negotiable 7).
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)
    store.recordFailure("a", { kind: "rate-limited", retryAfterSeconds: 60, message: "429" }, NOW)

    const state = store.stateOf("a")
    expect(state.breaker.status).toBe("exhausted")
    expect(state.breaker.cooldownUntil).toBeUndefined()
  })

  test("a late failure of any kind leaves a terminal verdict standing — first verdict wins", () => {
    const store = createHealthStore({ failureThreshold: 1, jitter: () => 0 })
    store.recordFailure("a", { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })
    store.recordFailure("a", { kind: "server-error", message: "500" }, NOW)
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    expect(store.stateOf("a").breaker.status).toBe("needs_reauth")
  })

  test("still records the reading of an exhausted account — refused, not discarded", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)
    store.applyRateLimit(
      "a",
      signal({
        limited: true,
        windows: [
          {
            limiter: "requests",
            limit: 100,
            remaining: 0,
            utilization: 1,
            utilizationSource: "continuous",
            resetSource: "unknown",
          },
        ],
      }),
      NOW,
    )

    const state = store.stateOf("a")
    expect(state.limiterWindows[0]?.remaining).toBe(0)
    expect(state.lastSignalAt).toEqual(NOW)
    expect(state.breaker.status).toBe("exhausted")
  })

  test("a limited header still extends an account that is only cooling down", () => {
    const store = createHealthStore()
    const near = new Date(NOW.getTime() + 10_000)
    const far = new Date(NOW.getTime() + 90_000)

    store.recordFailure(
      "a",
      { kind: "rate-limited", resetsAt: near, resetSource: "provider-reported", message: "429" },
      NOW,
    )
    store.applyRateLimit(
      "a",
      signal({ limited: true, resetsAt: far, resetSource: "provider-reported" }),
      NOW,
    )

    expect(store.stateOf("a").breaker.cooldownUntil).toEqual(far)
  })

  test("keeps the limiter windows the provider reported, under its own names", () => {
    const store = createHealthStore()
    store.applyRateLimit(
      "a",
      signal({
        windows: [
          {
            limiter: "input-tokens",
            limit: 100,
            remaining: 40,
            utilization: 0.6,
            utilizationSource: "continuous",
            resetSource: "unknown",
          },
        ],
      }),
      NOW,
    )

    expect(store.stateOf("a").limiterWindows[0]?.limiter).toBe("input-tokens")
    expect(store.stateOf("a").lastSignalAt).toEqual(NOW)
  })

  test("a success clears the streak and returns the account to active", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "server-error", message: "500" }, NOW)
    store.recordSuccess("a")

    expect(store.stateOf("a").breaker).toMatchObject({ status: "active", consecutiveFailures: 0 })
  })

  test("in-flight and recent tokens track what least-used ranks on", () => {
    const store = createHealthStore()
    store.beginAttempt("a")
    expect(store.stateOf("a").inFlight).toBe(1)

    store.endAttempt("a", 250)
    expect(store.stateOf("a")).toMatchObject({ inFlight: 0, recentTokens: 250 })
  })
})

/**
 * `breaker.ts` reads no configuration and no randomness of its own, so a store that supplies
 * neither runs the module defaults and returns every account tripped in the same second in the
 * same millisecond. These pin that the operator's numbers actually arrive.
 */
describe("the breaker's configured numbers reach it", () => {
  const cool = (store: ReturnType<typeof createHealthStore>, times: number): void => {
    for (let index = 0; index < times; index += 1) {
      store.recordFailure("a", { kind: "server-error", message: "500" }, NOW)
    }
  }

  test("the configured failure threshold decides when the breaker trips", () => {
    const store = createHealthStore({ failureThreshold: 5, jitter: () => 0 })

    cool(store, 4)
    expect(store.stateOf("a").breaker.status).toBe("active")

    cool(store, 1)
    expect(store.stateOf("a").breaker.status).toBe("cooling_down")
  })

  test("the configured backoff decides how long, and the ceiling caps it", () => {
    const store = createHealthStore({
      failureThreshold: 1,
      baseBackoffMs: 7_000,
      maxBackoffMs: 9_000,
      jitter: () => 0,
    })

    cool(store, 1)
    expect(store.stateOf("a").breaker.cooldownUntil).toEqual(new Date(NOW.getTime() + 7_000))

    cool(store, 1)
    expect(store.stateOf("a").breaker.cooldownUntil).toEqual(new Date(NOW.getTime() + 9_000))
  })

  test("a caller's authKind still wins — it is the only fact the store does not have", () => {
    const store = createHealthStore({ baseBackoffMs: 7_000, jitter: () => 0 })
    store.recordFailure("a", { kind: "auth", message: "401" }, NOW, { authKind: "api-key" })

    expect(store.stateOf("a").breaker.status).toBe("disabled")
  })

  test("jitter widens the estimated step, so accounts tripped together do not return together", () => {
    const wide = createHealthStore({ failureThreshold: 1, baseBackoffMs: 1_000, jitter: () => 1 })
    const none = createHealthStore({ failureThreshold: 1, baseBackoffMs: 1_000, jitter: () => 0 })
    cool(wide, 1)
    cool(none, 1)

    const widened = wide.stateOf("a").breaker.cooldownUntil?.getTime() ?? 0
    expect(widened).toBeGreaterThan(none.stateOf("a").breaker.cooldownUntil?.getTime() ?? 0)
  })

  test("jitter never moves a reset the provider actually reported", () => {
    const store = createHealthStore({ jitter: () => 1 })
    const resetsAt = new Date(NOW.getTime() + 60_000)
    store.recordFailure("a", { kind: "rate-limited", resetsAt, message: "429" }, NOW)

    expect(store.stateOf("a").breaker.cooldownUntil).toEqual(resetsAt)
  })

  test("a header-only limit takes the same numbers — that call site used to pass none", () => {
    const store = createHealthStore({ baseBackoffMs: 7_000, jitter: () => 0 })
    // No reset reported anywhere in the signal, so the estimate is the configured backoff.
    store.applyRateLimit("a", signal({ limited: true }), NOW)

    expect(store.stateOf("a").breaker.cooldownUntil).toEqual(new Date(NOW.getTime() + 7_000))
  })
})

/**
 * "One request is allowed through as a probe" — the spec's words, and until this gate existed
 * nothing implemented them: a cooldown expiring made the account eligible to every waiting request
 * at once.
 */
describe("the half-open probe gate", () => {
  const cooling = (holdMs = 30_000): ReturnType<typeof createHealthStore> => {
    const store = createHealthStore({ probeHoldMs: holdMs, jitter: () => 0 })
    store.recordFailure(
      "a",
      { kind: "rate-limited", resetsAt: new Date(NOW.getTime() + 60_000), message: "429" },
      NOW,
    )
    return store
  }

  const recovered = new Date(NOW.getTime() + 60_000)

  test("the first request through takes the probe; the rest are refused", () => {
    const store = cooling()

    expect(store.admitProbe("a", recovered)).toEqual({ admitted: true, held: true })
    expect(store.admitProbe("a", recovered)).toEqual({ admitted: false, held: false })
    expect(store.admitProbe("a", recovered)).toEqual({ admitted: false, held: false })
  })

  test("the hold is visible to the pure filter, carrying its own expiry", () => {
    const store = cooling(15_000)
    store.admitProbe("a", recovered)

    const overlaid = buildSnapshot(catalog([account("a")]), store, recovered).accounts[0]
    expect(overlaid?.health.probeHeldUntil).toEqual(new Date(recovered.getTime() + 15_000))
  })

  test("releasing hands the gate to the next request", () => {
    const store = cooling()
    store.admitProbe("a", recovered)
    store.releaseProbe("a")

    expect(store.admitProbe("a", recovered).admitted).toBe(true)
    expect(store.stateOf("a").probeHeldUntil).not.toBeNull()
  })

  test("a probe that never reports expires — a lost probe cannot park an account", () => {
    const store = cooling(15_000)
    store.admitProbe("a", recovered)

    expect(store.admitProbe("a", new Date(recovered.getTime() + 14_999)).admitted).toBe(false)
    expect(store.admitProbe("a", new Date(recovered.getTime() + 15_000)).admitted).toBe(true)
  })

  test("an account still cooling is refused: no probe is due yet", () => {
    expect(cooling().admitProbe("a", NOW)).toEqual({ admitted: false, held: false })
  })

  test("an account a human must fix is refused: no probe will change it", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    expect(store.admitProbe("a", new Date(NOW.getTime() + 86_400_000)).admitted).toBe(false)
  })

  test("an account that recovered under us is admitted, and owes no release", () => {
    // Another request's probe already succeeded. Refusing here would drop a healthy account from a
    // chain for nothing, and releasing a hold it never took could free somebody else's.
    const store = cooling()
    store.recordSuccess("a")

    expect(store.admitProbe("a", recovered)).toEqual({ admitted: true, held: false })
  })

  test("per account, never global — many accounts of one provider is the normal case", () => {
    const store = cooling()
    store.recordFailure(
      "b",
      { kind: "rate-limited", resetsAt: new Date(NOW.getTime() + 60_000), message: "429" },
      NOW,
    )

    expect(store.admitProbe("a", recovered).admitted).toBe(true)
    expect(store.admitProbe("b", recovered).admitted).toBe(true)
  })

  test("Re-check now clears the hold with the marks — one recovery path, one gate", () => {
    // `services/accounts/recheck.ts` calls exactly this. A hold left behind would make the operator's
    // button wait out a probe nobody is running.
    const store = cooling()
    store.admitProbe("a", recovered)
    store.reset("a")

    expect(store.stateOf("a").probeHeldUntil).toBeNull()
  })
})

/**
 * Where every quota-driven surface gets its data. Nothing wrote `quotaWindows` before this: the
 * filter's `quota-window-spent` could not fire, `quota-aware` ranked on nothing, and the console
 * rendered empty gauges on accounts the provider had already cut off.
 */
describe("quota windows", () => {
  const window = (overrides: Partial<QuotaWindowState> = {}): QuotaWindowState => ({
    window: "five_hour",
    utilization: 1,
    utilizationSource: "threshold-triggered",
    resetsAt: new Date(NOW.getTime() + 3_600_000),
    resetSource: "provider-reported",
    lastCheckedAt: NOW,
    ...overrides,
  })

  test("folds the named windows a signal carried into account state", () => {
    const store = createHealthStore()
    store.applyRateLimit("a", signal({ quotaWindows: [window()] }), NOW)

    expect(store.stateOf("a").quotaWindows).toEqual([window()])
  })

  test("a reading replaces the kinds it names and leaves the ones it does not standing", () => {
    // A turn that reported `five_hour` said nothing about `seven_day`. Treating that silence as a
    // refill would hand routing an account it believes is free while a seven-day window blocks it.
    const store = createHealthStore()
    store.applyRateLimit(
      "a",
      signal({ quotaWindows: [window(), window({ window: "seven_day", utilization: 0.5 })] }),
      NOW,
    )
    store.applyRateLimit("a", signal({ quotaWindows: [window({ utilization: 0.2 })] }), NOW)

    expect(store.stateOf("a").quotaWindows).toEqual([
      window({ utilization: 0.2 }),
      window({ window: "seven_day", utilization: 0.5 }),
    ])
  })

  test("a signal with no named windows leaves the ones already held alone", () => {
    // Every HTTP driver, every response: limiter names have no `QuotaWindowKind` equivalent, so
    // they say nothing about named windows rather than claiming there are none.
    const store = createHealthStore()
    store.applyRateLimit("a", signal({ quotaWindows: [window()] }), NOW)
    store.applyRateLimit("a", signal({ windows: [] }), NOW)

    expect(store.stateOf("a").quotaWindows).toEqual([window()])
  })

  test("the reading is kept even when a terminal verdict refuses the transition", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)
    store.applyRateLimit("a", signal({ limited: true, quotaWindows: [window()] }), NOW)

    expect(store.stateOf("a").quotaWindows).toEqual([window()])
    expect(store.stateOf("a").breaker.status).toBe("exhausted")
  })

  test("every fold reaches the durable writer, with the whole reading", () => {
    const seen: { accountId: string; windows: readonly QuotaWindowState[] }[] = []
    const store = createHealthStore({
      onQuotaWindows: (accountId, windows) => seen.push({ accountId, windows }),
    })

    store.applyRateLimit("a", signal({ quotaWindows: [window()] }), NOW)
    store.applyRateLimit("a", signal({ quotaWindows: [window({ window: "seven_day" })] }), NOW)

    expect(seen).toHaveLength(2)
    expect(seen[0]?.accountId).toBe("a")
    expect(seen[1]?.windows).toEqual([window(), window({ window: "seven_day" })])
  })

  test("a signal with nothing named never wakes the writer", () => {
    let calls = 0
    const store = createHealthStore({ onQuotaWindows: () => (calls += 1) })
    store.applyRateLimit("a", signal({ limited: true }), NOW)

    expect(calls).toBe(0)
  })

  test("Re-check now drops the windows and says so, so the SDK's own copy goes with them", () => {
    // Without the second half, the operator dismisses a spent window and the next
    // `rate_limit_event` re-publishes it from the store's own bucket.
    const forgotten: string[] = []
    const store = createHealthStore({ onReset: (accountId) => forgotten.push(accountId) })
    store.applyRateLimit("a", signal({ quotaWindows: [window()] }), NOW)
    store.reset("a")

    expect(store.stateOf("a").quotaWindows).toEqual([])
    expect(forgotten).toEqual(["a"])
  })

  test("live readings overlay the stored ones, per kind", () => {
    const stored = window({ utilization: 0.1, lastCheckedAt: new Date(NOW.getTime() - 3_600_000) })
    const seven = window({ window: "seven_day", utilization: 0.4 })
    const store = createHealthStore()
    store.applyRateLimit("a", signal({ quotaWindows: [window({ utilization: 0.9 })] }), NOW)

    const overlaid = overlayHealth(
      account("a", { snapshot: { quotaWindows: [stored, seven] } }).snapshot,
      store.stateOf("a"),
    )

    expect(overlaid.quotaWindows).toEqual([window({ utilization: 0.9 }), seven])
  })

  test("a stored row that is newer wins — the quota floor's clear is not re-asserted", () => {
    // The floor retires a window whose own reset has passed, writing `none` / `unknown` with a
    // fresh `lastCheckedAt`. This replica may still hold the spent reading it observed hours ago;
    // overlaying that back would show a 100% gauge on a window that has since refilled.
    const store = createHealthStore()
    const stale = new Date(NOW.getTime() - 7_200_000)
    store.applyRateLimit(
      "a",
      signal({ quotaWindows: [window({ lastCheckedAt: stale, resetsAt: stale })] }),
      stale,
    )
    const cleared = window({
      utilization: undefined,
      utilizationSource: "none",
      resetsAt: undefined,
      resetSource: "unknown",
      lastCheckedAt: NOW,
    })

    const overlaid = overlayHealth(
      account("a", { snapshot: { quotaWindows: [cleared] } }).snapshot,
      store.stateOf("a"),
    )

    expect(overlaid.quotaWindows).toEqual([cleared])
  })

  test("an account nobody has observed keeps the hydrated rows and absent stays absent", () => {
    const fresh = createHealthStore().stateOf("a")
    const stored = window({ utilization: 0.3 })

    expect(
      overlayHealth(account("a", { snapshot: { quotaWindows: [stored] } }).snapshot, fresh),
    ).toMatchObject({ quotaWindows: [stored] })
    expect(overlayHealth(account("a").snapshot, fresh).quotaWindows).toBeUndefined()
  })

  test("limiter readings reach selection under the provider's own names, for ranking", () => {
    // `requests` and `input-tokens` have no `QuotaWindowKind`, so they never become quota windows —
    // but they are the router's only *continuous* reading, and `quota-aware` ranks on nothing else.
    const store = createHealthStore()
    store.applyRateLimit(
      "a",
      signal({
        windows: [
          {
            limiter: "input-tokens",
            limit: 100,
            remaining: 25,
            utilization: 0.75,
            utilizationSource: "continuous",
            resetSource: "unknown",
          },
        ],
      }),
      NOW,
    )

    const overlaid = overlayHealth(account("a").snapshot, store.stateOf("a"))
    expect(overlaid.limiterWindows).toEqual([
      { limiter: "input-tokens", utilization: 0.75, utilizationSource: "continuous" },
    ])
    expect(overlaid.quotaWindows).toBeUndefined()
  })
})

/**
 * The other half of durable health: a standing block has to leave this process to be worth
 * anything, and the announcement is the only seam it can leave through.
 */
describe("standing blocks are announced", () => {
  function blocks() {
    const seen: { accountId: string; status: AccountStatus }[] = []
    return {
      seen,
      store: createHealthStore({
        onBlocked: (accountId, status) => seen.push({ accountId, status }),
      }),
    }
  }

  test("out of credits is announced, because only a human ends it", () => {
    const { store, seen } = blocks()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    expect(seen).toEqual([{ accountId: "a", status: "exhausted" }])
  })

  test("an oauth auth failure is announced as needs_reauth", () => {
    const { store, seen } = blocks()
    store.recordFailure("a", { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })

    expect(seen).toEqual([{ accountId: "a", status: "needs_reauth" }])
  })

  test("the disabled an api-key failure forms is announced too — storing it is not this file's call", () => {
    // The store reports every block it makes; `status-writer.ts` decides which are durable. One
    // predicate, one file, rather than the same exclusion written in two places that can drift.
    const { store, seen } = blocks()
    store.recordFailure("a", { kind: "auth", message: "401" }, NOW, { authKind: "api-key" })

    expect(seen).toEqual([{ accountId: "a", status: "disabled" }])
  })

  test("a cooldown is not announced — a clock ends it, so nobody needs telling", () => {
    const { store, seen } = blocks()
    store.recordFailure("a", { kind: "rate-limited", retryAfterSeconds: 30, message: "429" }, NOW)
    store.applyRateLimit("a", signal({ limited: true, retryAfterSeconds: 30 }), NOW)

    expect(store.stateOf("a").breaker.status).toBe("cooling_down")
    expect(seen).toEqual([])
  })

  test("a failure below the trip threshold announces nothing", () => {
    const { store, seen } = blocks()
    store.recordFailure("a", { kind: "server-error", message: "500" }, NOW)

    expect(seen).toEqual([])
  })

  test("once per transition, not once per failure", () => {
    // Fifty concurrent requests all seeing the same 402 are one verdict, and one log line.
    const { store, seen } = blocks()
    for (let index = 0; index < 50; index += 1) {
      store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)
    }

    expect(seen).toHaveLength(1)
  })

  test("re-announced after a recovery, because the row was cleared with the marks", () => {
    const { store, seen } = blocks()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)
    store.reset("a")
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    expect(seen).toHaveLength(2)
  })
})

describe("snapshot", () => {
  test("overlays live breaker state onto the account's routing view", () => {
    const store = createHealthStore()
    store.recordFailure("a", { kind: "credits-exhausted", message: "402" }, NOW)

    const snapshot = buildSnapshot(catalog([account("a")]), store, NOW)

    expect(snapshot.accounts[0]?.status).toBe("exhausted")
  })

  test("never promotes an account the operator disabled", () => {
    const disabled = account("a", { snapshot: { status: "disabled" } })
    const overlaid = overlayHealth(disabled.snapshot, createHealthStore().stateOf("a"))
    expect(overlaid.status).toBe("disabled")
  })
})
