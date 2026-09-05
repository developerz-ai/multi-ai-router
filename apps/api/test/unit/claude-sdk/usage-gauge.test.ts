import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import {
  createSdkQuotaStore,
  createSdkUsageGauge,
  readSdkUsageGauge,
  type SdkUsageGaugeReading,
  type SdkUsageGaugeSource,
} from "../../../src/providers"

/**
 * The usage gauge (`usage-gauge.ts`, `quota-reading.ts`, `quota.ts#ingestGauge`): the continuous
 * half of a subscription's quota picture. What is pinned: the read never delays or fails a turn,
 * it is coalesced per account, its payload is validated tolerantly, and its reading is labelled
 * `continuous` in the store without ever becoming a verdict.
 */

const NOW = new Date("2026-09-05T12:00:00.000Z")
const LATER = new Date(NOW.getTime() + 3_600_000).toISOString()

const PAYLOAD = {
  session: { total_cost_usd: 0.1 },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: LATER },
    seven_day: { utilization: 7.5, resets_at: LATER },
    seven_day_oauth_apps: { utilization: 99, resets_at: LATER },
    model_scoped: [{ display_name: "Opus", utilization: 3, resets_at: LATER }],
  },
}

function source(
  answer: () => Promise<unknown>,
): SdkUsageGaugeSource & { readonly calls: { count: number } } {
  const calls = { count: 0 }
  return {
    calls,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
      calls.count += 1
      return answer()
    },
  }
}

function gauge(overrides: { enabled?: boolean; timeoutMs?: number; minIntervalMs?: number } = {}) {
  const readings: { accountId: string; reading: SdkUsageGaugeReading }[] = []
  const logs: { msg: string; level: string }[] = []
  const clock = { now: NOW }
  const created = createSdkUsageGauge({
    enabled: overrides.enabled ?? true,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    minIntervalMs: overrides.minIntervalMs ?? 60_000,
    now: () => clock.now,
    logger: createLogger({
      level: "debug",
      write: (line) => {
        const parsed = JSON.parse(line) as { msg: string; level: string }
        logs.push({ msg: parsed.msg, level: parsed.level })
      },
    }),
    onReading: (accountId, reading) => {
      readings.push({ accountId, reading })
    },
  })
  return { gauge: created, readings, logs, clock }
}

describe("reading the usage payload", () => {
  test("scales percentages to fractions, keeps only known windows, and parses ISO resets", () => {
    const reading = readSdkUsageGauge(PAYLOAD, NOW)
    expect(reading).not.toBeNull()
    expect(reading?.available).toBe(true)
    expect(reading?.subscriptionType).toBe("max")
    expect(reading?.windows).toEqual([
      { kind: "five_hour", utilization: 0.42, resetsAt: new Date(LATER) },
      { kind: "seven_day", utilization: 0.075, resetsAt: new Date(LATER) },
    ])
  })

  test("an overshoot clamps to spent, a past reset reads as none, a null utilization stays null", () => {
    const reading = readSdkUsageGauge(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 150, resets_at: "2020-01-01T00:00:00Z" },
          seven_day: { utilization: null, resets_at: "not a date" },
        },
      },
      NOW,
    )
    expect(reading?.windows).toEqual([
      { kind: "five_hour", utilization: 1, resetsAt: null },
      { kind: "seven_day", utilization: null, resetsAt: null },
    ])
  })

  test("plan limits not applying is a reading with no windows, not a failure", () => {
    const reading = readSdkUsageGauge(
      { subscription_type: null, rate_limits_available: false, rate_limits: null },
      NOW,
    )
    expect(reading).toEqual({ available: false, subscriptionType: null, windows: [] })
  })

  test("a non-object payload is null — the caller drops it", () => {
    expect(readSdkUsageGauge("nope", NOW)).toBeNull()
    expect(readSdkUsageGauge(null, NOW)).toBeNull()
  })
})

describe("taking a reading", () => {
  test("asks once, validates, and hands the reading on", async () => {
    const { gauge: g, readings } = gauge()
    const src = source(async () => PAYLOAD)

    await g.observe("sub-1", src)

    expect(src.calls.count).toBe(1)
    expect(readings).toHaveLength(1)
    expect(readings[0]?.accountId).toBe("sub-1")
    expect(readings[0]?.reading.windows.map((window) => window.kind)).toEqual([
      "five_hour",
      "seven_day",
    ])
  })

  test("coalesces per account: one read per interval, counted from the start", async () => {
    const { gauge: g, clock } = gauge({ minIntervalMs: 60_000 })
    const src = source(async () => PAYLOAD)

    await g.observe("sub-1", src)
    await g.observe("sub-1", src)
    await g.observe("sub-2", src)
    expect(src.calls.count).toBe(2)

    clock.now = new Date(NOW.getTime() + 60_000)
    await g.observe("sub-1", src)
    expect(src.calls.count).toBe(3)
  })

  test("no plan limits is reported once per account at info, and nothing lands", async () => {
    const { gauge: g, readings, logs, clock } = gauge({ minIntervalMs: 0 })
    const src = source(async () => ({ rate_limits_available: false, rate_limits: null }))

    await g.observe("sub-1", src)
    clock.now = new Date(NOW.getTime() + 1)
    await g.observe("sub-1", src)

    expect(readings).toEqual([])
    expect(logs.filter((line) => line.msg.includes("no plan limits"))).toHaveLength(1)
  })

  test("a malformed payload is logged at debug and dropped", async () => {
    const { gauge: g, readings, logs } = gauge()
    await g.observe(
      "sub-1",
      source(async () => 42),
    )

    expect(readings).toEqual([])
    expect(logs).toContainEqual({ msg: "sdk usage gauge payload unreadable", level: "debug" })
  })

  test("a slow endpoint is bounded by the timeout and never rejects", async () => {
    const { gauge: g, readings, logs } = gauge({ timeoutMs: 5 })
    await g.observe(
      "sub-1",
      source(() => new Promise(() => {})),
    )

    expect(readings).toEqual([])
    expect(logs.some((line) => line.msg === "sdk usage gauge unavailable")).toBe(true)
  })

  test("a rejected control request is a dropped reading, not a thrown one", async () => {
    const { gauge: g, readings } = gauge()
    await g.observe(
      "sub-1",
      source(() => Promise.reject(new Error("Query closed before response received"))),
    )
    expect(readings).toEqual([])
  })

  test("disabled, or a query object without the method, asks nothing", async () => {
    const off = gauge({ enabled: false })
    const src = source(async () => PAYLOAD)
    await off.gauge.observe("sub-1", src)
    expect(src.calls.count).toBe(0)

    const { gauge: g, readings } = gauge()
    await g.observe("sub-1", {})
    expect(readings).toEqual([])
  })

  test("a sink that throws is logged, and the promise still resolves", async () => {
    const logs: string[] = []
    const g = createSdkUsageGauge({
      enabled: true,
      timeoutMs: 1_000,
      minIntervalMs: 0,
      onReading: () => {
        throw new Error("store exploded")
      },
      logger: createLogger({
        level: "debug",
        write: (line) => logs.push((JSON.parse(line) as { msg: string }).msg),
      }),
    })
    await g.observe(
      "sub-1",
      source(async () => PAYLOAD),
    )
    expect(logs).toContain("sdk usage gauge reading not applied")
  })
})

describe("folding a gauge into the quota store", () => {
  const reading = (): SdkUsageGaugeReading => {
    const parsed = readSdkUsageGauge(PAYLOAD, NOW)
    if (parsed === null) throw new Error("fixture must parse")
    return parsed
  }

  test("labels the windows continuous and never claims a refusal", () => {
    const store = createSdkQuotaStore()
    const snapshot = store.ingestGauge("sub", reading(), NOW)

    expect(snapshot.signal.limited).toBe(false)
    expect(snapshot.windows).toEqual([
      expect.objectContaining({
        window: "five_hour",
        utilization: 0.42,
        utilizationSource: "continuous",
        resetSource: "provider-reported",
      }),
      expect.objectContaining({ window: "seven_day", utilization: 0.075 }),
    ])
  })

  test("an alarm that carried no utilization leaves the gauge's number standing", () => {
    const store = createSdkQuotaStore()
    store.ingestGauge("sub", reading(), NOW)
    const snapshot = store.ingest("sub", { status: "allowed", rateLimitType: "five_hour" }, NOW)

    const window = snapshot?.windows.find((entry) => entry.window === "five_hour")
    expect(window?.utilization).toBe(0.42)
    expect(window?.utilizationSource).toBe("continuous")
  })

  test("an alarm that carried a utilization wins, and is labelled the alarm it is", () => {
    const store = createSdkQuotaStore()
    store.ingestGauge("sub", reading(), NOW)
    const snapshot = store.ingest(
      "sub",
      { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.97 },
      NOW,
    )

    const window = snapshot?.windows.find((entry) => entry.window === "five_hour")
    expect(window?.utilization).toBe(0.97)
    expect(window?.utilizationSource).toBe("threshold-triggered")
  })

  test("a gauge never lifts a rejection, and its own signal never carries one", () => {
    const store = createSdkQuotaStore()
    store.ingest("sub", { status: "rejected", rateLimitType: "five_hour" }, NOW)

    const gauged = store.ingestGauge("sub", reading(), NOW)
    expect(gauged.signal.limited).toBe(false)

    // The verdict is still there for the event path to report.
    expect(store.snapshot("sub")?.signal.limited).toBe(true)
  })
})
