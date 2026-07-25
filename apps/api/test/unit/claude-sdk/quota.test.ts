import { describe, expect, test } from "bun:test"
import { createSdkQuotaStore, type SdkQuotaStore } from "../../../src/providers"

/**
 * `rate_limit_event` folded into Account state (docs/idea/11-anthropic-agent-sdk.md §5).
 *
 * The properties worth pinning are the ones a misreading would hide: an alarm must never be
 * labelled a gauge, an event that named no window must still cool the account down without
 * inventing which window it spent, and two accounts must never share a reading.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z")
const IN_AN_HOUR = NOW.getTime() + 3_600_000

function ingest(store: SdkQuotaStore, info: unknown, now: Date = NOW) {
  return store.ingest("sub", info, now)
}

describe("ingesting a rate-limit event", () => {
  test("a named window becomes a window, and its utilization is labelled an alarm", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.93,
      resetsAt: IN_AN_HOUR,
    })

    expect(snapshot?.windows).toHaveLength(1)
    const window = snapshot?.windows[0]
    expect(window?.window).toBe("five_hour")
    expect(window?.utilization).toBe(0.93)
    // The one label that stops `quota-aware` ranking accounts on a reading that is absent for most
    // of every window.
    expect(window?.utilizationSource).toBe("threshold-triggered")
    expect(window?.resetSource).toBe("provider-reported")
    expect(window?.lastCheckedAt).toEqual(NOW)
    // A warning is not a refusal.
    expect(snapshot?.signal.limited).toBe(false)
  })

  test("an absent utilization is absent, never zero", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "allowed",
      rateLimitType: "seven_day",
    })

    expect(snapshot?.windows[0]?.utilization).toBeUndefined()
    // Zero would read as "wide open" to `isWindowSpent`; "none" says we were told nothing.
    expect(snapshot?.windows[0]?.utilizationSource).toBe("none")
    expect(snapshot?.windows[0]?.resetSource).toBe("unknown")
  })

  test("a rejection cools the account down and hands the breaker the window's own reset", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "rejected",
      rateLimitType: "seven_day_opus",
      utilization: 1,
      resetsAt: IN_AN_HOUR,
    })

    expect(snapshot?.signal.limited).toBe(true)
    expect(snapshot?.signal.resetsAt).toEqual(new Date(IN_AN_HOUR))
    expect(snapshot?.signal.resetSource).toBe("provider-reported")
  })

  test("an event that named no window still refuses, but is never rendered as a window", () => {
    const snapshot = ingest(createSdkQuotaStore(), { status: "rejected", resetsAt: IN_AN_HOUR })

    expect(snapshot?.signal.limited).toBe(true)
    // Naming a window here would invent the one fact the event withheld.
    expect(snapshot?.windows).toHaveLength(0)
    expect(snapshot?.signal.windows.map((entry) => entry.limiter)).toEqual(["default"])
  })

  test("a window kind this build does not know keeps the SDK's own word and stays unrendered", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "rejected",
      rateLimitType: "seven_day_haiku",
    })

    expect(snapshot?.windows).toHaveLength(0)
    expect(snapshot?.signal.windows.map((entry) => entry.limiter)).toEqual(["seven_day_haiku"])
    expect(snapshot?.signal.limited).toBe(true)
  })

  test("windows accumulate and the soonest *blocking* reset is the one the breaker gets", () => {
    const store = createSdkQuotaStore()
    ingest(store, {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      resetsAt: NOW.getTime() + 60_000,
    })
    const snapshot = ingest(store, {
      status: "rejected",
      rateLimitType: "seven_day",
      resetsAt: IN_AN_HOUR,
    })

    expect(snapshot?.windows.map((entry) => entry.window)).toEqual(["five_hour", "seven_day"])
    // The warning window refills sooner, but it is not what is blocking, so borrowing its reset
    // would understate the cooldown.
    expect(snapshot?.signal.resetsAt).toEqual(new Date(IN_AN_HOUR))
  })

  test("a later event on the same window replaces the earlier reading", () => {
    const store = createSdkQuotaStore()
    ingest(store, { status: "rejected", rateLimitType: "five_hour", utilization: 1 })
    const snapshot = ingest(store, { status: "allowed", rateLimitType: "five_hour" })

    expect(snapshot?.windows).toHaveLength(1)
    expect(snapshot?.signal.limited).toBe(false)
  })

  test("a reset already in the past is dropped rather than passed on as a cooldown of zero", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "rejected",
      rateLimitType: "five_hour",
      // What a seconds-valued timestamp looks like read as milliseconds, and what late delivery
      // looks like too. Either way the breaker's own backoff is the honest answer.
      resetsAt: 1_784_000_000,
    })

    expect(snapshot?.signal.limited).toBe(true)
    expect(snapshot?.signal.resetsAt).toBeUndefined()
    expect(snapshot?.signal.resetSource).toBe("unknown")
  })

  test("utilization outside 0..1 is clamped to what the domain admits", () => {
    const store = createSdkQuotaStore()
    expect(
      ingest(store, { rateLimitType: "five_hour", utilization: 1.4 })?.windows[0]?.utilization,
    ).toBe(1)
    expect(
      ingest(store, { rateLimitType: "five_hour", utilization: -2 })?.windows[0]?.utilization,
    ).toBe(0)
  })

  test("both spellings of every field are read", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "rejected",
      rate_limit_type: "seven_day_sonnet",
      resets_at: IN_AN_HOUR,
      utilization: 0.99,
      is_using_overage: true,
    })

    expect(snapshot?.windows[0]?.window).toBe("seven_day_sonnet")
    expect(snapshot?.signal.resetsAt).toEqual(new Date(IN_AN_HOUR))
    expect(snapshot?.usingOverage).toBe(true)
  })

  test("an unreadable payload costs this update and nothing else", () => {
    const store = createSdkQuotaStore()
    ingest(store, { status: "rejected", rateLimitType: "five_hour" })

    expect(ingest(store, "not an event")).toBeNull()
    expect(ingest(store, null)).toBeNull()
    expect(store.snapshot("sub")?.signal.limited).toBe(true)
  })
})

describe("the overage window", () => {
  test("is recorded from the detail beside the event, and never blocks on its own", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "allowed",
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageResetsAt: IN_AN_HOUR,
      isUsingOverage: true,
    })

    const overage = snapshot?.windows.find((entry) => entry.window === "overage")
    expect(overage?.resetsAt).toEqual(new Date(IN_AN_HOUR))
    expect(snapshot?.usingOverage).toBe(true)
    // A rejected top-up says nothing about the included window that is serving this request fine.
    expect(snapshot?.signal.limited).toBe(false)
  })

  test("an event about the overage window itself keeps its own refusal", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "rejected",
      rateLimitType: "overage",
      resetsAt: IN_AN_HOUR,
    })

    expect(snapshot?.windows.map((entry) => entry.window)).toEqual(["overage"])
    expect(snapshot?.signal.limited).toBe(true)
  })

  test("no overage detail means no overage window is invented", () => {
    const snapshot = ingest(createSdkQuotaStore(), {
      status: "allowed",
      rateLimitType: "five_hour",
    })

    expect(snapshot?.windows.map((entry) => entry.window)).toEqual(["five_hour"])
    expect(snapshot?.usingOverage).toBe(false)
  })
})

describe("the store itself", () => {
  test("keys state by account, and two stores never share it", () => {
    const store = createSdkQuotaStore()
    store.ingest("sub-a", { status: "rejected", rateLimitType: "five_hour" }, NOW)

    expect(store.snapshot("sub-a")?.signal.limited).toBe(true)
    expect(store.snapshot("sub-b")).toBeNull()
    // Never a process singleton: a second store starts empty, in this process and in every test.
    expect(createSdkQuotaStore().snapshot("sub-a")).toBeNull()
  })

  test("forgetting an account drops every reading it had", () => {
    const store = createSdkQuotaStore()
    ingest(store, { status: "rejected", rateLimitType: "five_hour" })

    store.forget("sub")

    expect(store.snapshot("sub")).toBeNull()
  })
})
