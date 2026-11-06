import { describe, expect, test } from "bun:test"
import type { ProviderId } from "@multi-ai-router/core"
import { httpDriver } from "../../../src/providers"
import { account } from "./fixtures"

/**
 * The MiniMax, z.ai and Kimi plan usage readers. Every body below is the live reply the production
 * router got on 2026-11-06 23:02Z from each provider's usage endpoint, while each of those Accounts
 * was refused for a spent weekly window — so the readings are the spent ones the fix exists for.
 */

const AT = new Date("2026-11-06T23:02:36.000Z")

function quotaRead(provider: ProviderId) {
  const found = httpDriver(provider)?.quotaRead
  if (found === undefined) throw new Error(`${provider} declares no quota read`)
  return found
}

const miniMaxLive = {
  model_remains: [
    {
      start_time: 1793995200000,
      end_time: 1794009600000,
      remains_time: 3443581,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1793577600000,
      weekly_end_time: 1794182400000,
      weekly_remains_time: 176243581,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      current_weekly_status: 2,
      current_weekly_remaining_percent: 0,
    },
    {
      start_time: 1793923200000,
      end_time: 1794009600000,
      current_interval_total_count: 5,
      current_interval_usage_count: 0,
      model_name: "video",
      current_weekly_total_count: 35,
      current_weekly_usage_count: 0,
      weekly_end_time: 1794182400000,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 100,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
}

const zaiLive = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 100, nextResetTime: 1794276151996 },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 0,
        remaining: 4000,
        percentage: 0,
        nextResetTime: 1794967351998,
        usageDetails: [{ modelCode: "search-prime", usage: 0 }],
      },
    ],
    level: "max",
  },
  success: true,
}

const kimiLive = {
  usage: { limit: "100", used: "100", resetTime: "2026-11-12T14:31:50.323760Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "100", resetTime: "2026-11-07T03:31:50.323760Z" },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0, reset_time: "2026-11-07T03:31:49Z" },
    limit_7d: { used_ratio: 1, reset_time: "2026-11-12T14:31:49Z" },
  },
}

describe("plan usage readers, refusals first", () => {
  const refusals: readonly [ProviderId, unknown][] = [
    ["minimax", undefined],
    // A refused key answers 200 with a non-zero base_resp: never a reading.
    [
      "minimax",
      { base_resp: { status_code: 1004, status_msg: "cookie is missing, log in again" } },
    ],
    ["minimax", { ...miniMaxLive, model_remains: [miniMaxLive.model_remains[1]] }],
    ["minimax", { base_resp: { status_code: 0 }, model_remains: [{ model_name: "general" }] }],
    ["zai", { code: 401, success: false, msg: "token expired" }],
    ["zai", { success: true, data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1 }] } }],
    [
      "zai",
      {
        success: true,
        data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 140 }] },
      },
    ],
    ["kimi", { usages: {} }],
    ["kimi", { usages: { limit_7d: { used_ratio: 100 } } }],
    ["kimi", { error: { type: "authentication_error" } }],
  ]
  for (const [provider, body] of refusals) {
    test(`${provider} refuses ${JSON.stringify(body)?.slice(0, 80)} whole`, () => {
      expect(quotaRead(provider).read(body, AT)).toBeNull()
    })
  }

  for (const provider of ["minimax", "zai", "kimi"] as const) {
    test(`${provider}: a key pointed at another endpoint is never sent to the pinned usage URL`, () => {
      expect(
        quotaRead(provider).url(account({ provider, baseUrl: "https://proxy.example/v1" })),
      ).toBeNull()
    })
  }

  test("no reading ever claims the account is limited now, even a spent one", () => {
    for (const [provider, body] of [
      ["minimax", miniMaxLive],
      ["zai", zaiLive],
      ["kimi", kimiLive],
    ] as const) {
      const signal = quotaRead(provider).read(body, AT)
      expect(signal?.limited).toBe(false)
      expect(signal?.retryAfterSeconds).toBeUndefined()
      for (const window of signal?.quotaWindows ?? []) expect(window.advisory).toBe(true)
    }
  })
})

describe("plan usage readers", () => {
  test("each targets its plan endpoint on an unmoved account", () => {
    expect(
      quotaRead("minimax")
        .url(account({ provider: "minimax" }))
        ?.toString(),
    ).toBe("https://api.minimax.io/v1/token_plan/remains")
    expect(
      quotaRead("zai")
        .url(account({ provider: "zai" }))
        ?.toString(),
    ).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
    expect(
      quotaRead("kimi")
        .url(account({ provider: "kimi" }))
        ?.toString(),
    ).toBe("https://api.kimi.com/coding/v1/usages")
  })

  test("minimax: the general bucket's weekly status 2 is spent until weekly_end_time", () => {
    expect(quotaRead("minimax").read(miniMaxLive, AT)?.quotaWindows).toEqual([
      {
        window: "five_hour",
        utilization: 0,
        utilizationSource: "continuous",
        resetsAt: new Date("2026-11-07T00:00:00.000Z"),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
      {
        window: "seven_day",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: new Date("2026-11-09T00:00:00.000Z"),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
    ])
  })

  test("minimax: a remaining percentage reads as the share consumed", () => {
    const [general] = miniMaxLive.model_remains
    const body = {
      ...miniMaxLive,
      model_remains: [
        { ...general, current_weekly_status: 1, current_weekly_remaining_percent: 30 },
      ],
    }
    expect(quotaRead("minimax").read(body, AT)?.quotaWindows?.[1]?.utilization).toBeCloseTo(0.7)
  })

  test("zai: the weekly reset is the 1310 stamp read as UTC+8, to the second", () => {
    const signal = quotaRead("zai").read(zaiLive, AT)
    expect(signal?.quotaWindows).toEqual([
      {
        window: "five_hour",
        utilization: 0,
        utilizationSource: "continuous",
        resetSource: "unknown",
        lastCheckedAt: AT,
        advisory: true,
      },
      {
        window: "seven_day",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: new Date(1794276151996),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
    ])
    // "Your limit will reset at 2026-11-10 10:02:31" (UTC+8), as zai.ts reads it.
    expect(signal?.quotaWindows?.[1]?.resetsAt?.toISOString().slice(0, 19)).toBe(
      "2026-11-10T02:02:31",
    )
    // The MCP tool-call allowance is not an inference quota: never ranked on.
    expect(signal?.windows).toEqual([])
  })

  test("zai: a token window of another span keeps its own name as a limiter window", () => {
    const body = {
      success: true,
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 5, number: 1, percentage: 40 }] },
    }
    expect(quotaRead("zai").read(body, AT)?.windows).toEqual([
      {
        limiter: "tokens-1-month",
        utilization: 0.4,
        utilizationSource: "continuous",
        resetSource: "unknown",
      },
    ])
  })

  test("kimi: limit_5h and limit_7d land on five_hour and seven_day", () => {
    expect(quotaRead("kimi").read(kimiLive, AT)?.quotaWindows).toEqual([
      {
        window: "five_hour",
        utilization: 0,
        utilizationSource: "continuous",
        resetsAt: new Date("2026-11-07T03:31:49Z"),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
      {
        window: "seven_day",
        utilization: 1,
        utilizationSource: "continuous",
        resetsAt: new Date("2026-11-12T14:31:49Z"),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
    ])
  })
})
