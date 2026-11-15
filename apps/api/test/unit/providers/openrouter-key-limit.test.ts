import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { nextKeyLimitReset } from "../../../src/providers/drivers/openrouter-key"
import { account } from "./fixtures"

/**
 * OpenRouter's `GET /api/v1/key`: a key's spend cap and the instant it next resets. The shape and
 * the boundaries are OpenRouter's documented ones (openrouter.ai/docs/api-reference/limits, read
 * 2026-11-14): `limit`, `limit_reset` (`daily` | `weekly` | `monthly` | null), `limit_remaining`;
 * budgets reset at 00:00 UTC, weeks run Monday to Sunday, months reset on the 1st.
 */

const AT = new Date("2026-11-14T18:30:00.000Z") // a Saturday

function quotaRead() {
  const read = httpDriver("openrouter")?.quotaRead
  if (read === undefined) throw new Error("openrouter declares no quota read")
  return read
}

const key = (data: Record<string, unknown>) => ({
  data: { label: "sk-or-v1-abc...xyz", usage: 41.2, is_free_tier: false, ...data },
})

describe("nextKeyLimitReset, the boundaries", () => {
  test("daily is the next 00:00 UTC", () => {
    expect(nextKeyLimitReset("daily", AT)).toEqual(new Date("2026-11-15T00:00:00.000Z"))
  })

  test("a reading taken exactly at midnight names the following one, never now", () => {
    const midnight = new Date("2026-11-15T00:00:00.000Z")
    expect(nextKeyLimitReset("daily", midnight)).toEqual(new Date("2026-11-16T00:00:00.000Z"))
  })

  test("weekly is the next Monday 00:00 UTC", () => {
    expect(nextKeyLimitReset("weekly", AT)).toEqual(new Date("2026-11-16T00:00:00.000Z"))
    const monday = new Date("2026-11-16T09:00:00.000Z")
    expect(nextKeyLimitReset("weekly", monday)).toEqual(new Date("2026-11-23T00:00:00.000Z"))
  })

  test("monthly is the 1st of the next month 00:00 UTC, across a year end", () => {
    expect(nextKeyLimitReset("monthly", AT)).toEqual(new Date("2026-12-01T00:00:00.000Z"))
    const december = new Date("2026-12-31T23:59:59.000Z")
    expect(nextKeyLimitReset("monthly", december)).toEqual(new Date("2027-01-01T00:00:00.000Z"))
  })
})

describe("the openrouter key reading, failures first", () => {
  test("an unreadable body is null, never a partial reading", () => {
    expect(quotaRead().read({ data: { limit: "30" } }, AT)).toBeNull()
    expect(quotaRead().read("nope", AT)).toBeNull()
  })

  test("a key with no cap states no window, and says it has no plan rather than failing", () => {
    const body = key({ limit: null, limit_reset: null, limit_remaining: null })
    expect(quotaRead().read(body, AT)).toBeNull()
    expect(quotaRead().noPlan?.(body)).toBe(true)
  })

  test("a cap that never resets is a spent window with no reset: it stays a human's", () => {
    const signal = quotaRead().read(key({ limit: 30, limit_reset: null, limit_remaining: 0 }), AT)
    expect(signal?.quotaWindows).toEqual([
      {
        window: "spend_limit",
        utilization: 1,
        utilizationSource: "continuous",
        resetSource: "unknown",
        lastCheckedAt: AT,
        advisory: true,
      },
    ])
  })

  test("the coding key: $30 daily, spent, resets at the next 00:00 UTC", () => {
    const signal = quotaRead().read(
      key({ limit: 30, limit_reset: "daily", limit_remaining: 0 }),
      AT,
    )
    expect(signal?.limited).toBe(false)
    expect(signal?.quotaWindows).toEqual([
      {
        window: "spend_limit",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: new Date("2026-11-15T00:00:00.000Z"),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
    ])
  })

  test("headroom reads as the fraction of the cap spent", () => {
    const signal = quotaRead().read(
      key({ limit: 30, limit_reset: "weekly", limit_remaining: 22.5 }),
      AT,
    )
    expect(signal?.quotaWindows?.[0]?.utilization).toBeCloseTo(0.25)
  })

  test("the endpoint is OpenRouter's own, and never one an operator pointed elsewhere", () => {
    const read = quotaRead()
    expect(read.url(account({ provider: "openrouter" }))?.href).toBe(
      "https://openrouter.ai/api/v1/key",
    )
    expect(read.url(account({ provider: "openrouter", baseUrl: "https://proxy.test/v1" }))).toBe(
      null,
    )
  })
})
