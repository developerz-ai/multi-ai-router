import { describe, expect, test } from "bun:test"
import {
  AccountStatus,
  AuthKind,
  DEFAULT_ROUTING_POLICY,
  Dialect,
  EgressMode,
  KeyScope,
  ProviderId,
  QuotaWindowKind,
  QuotaWindowState,
  ResetSource,
  RoutingPolicy,
  UtilizationSource,
} from "../../src/index"

const enums = [
  {
    name: "AccountStatus",
    schema: AccountStatus,
    valid: ["active", "disabled", "cooling_down", "exhausted", "needs_reauth"],
    invalid: ["cooling-down", "coolingDown", "pending", "ACTIVE", "", "exhausted "],
  },
  {
    name: "RoutingPolicy",
    schema: RoutingPolicy,
    valid: ["sticky", "round-robin", "weighted", "least-used", "priority-failover", "quota-aware"],
    invalid: ["round_robin", "random", "least-loaded", "Sticky", "", "quota aware"],
  },
  {
    name: "KeyScope",
    schema: KeyScope,
    valid: ["all", "pools", "accounts"],
    invalid: ["pool", "account", "any", "*", ""],
  },
  {
    name: "Dialect",
    schema: Dialect,
    valid: ["anthropic", "openai-chat", "openai-responses"],
    invalid: ["openai", "anthropic-messages", "gemini", "openai_chat", ""],
  },
  {
    name: "EgressMode",
    schema: EgressMode,
    valid: ["passthrough", "translate", "agent-sdk"],
    invalid: ["translation", "agent_sdk", "sdk", "proxy", ""],
  },
  {
    name: "QuotaWindowKind",
    schema: QuotaWindowKind,
    valid: ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"],
    invalid: ["five-hour", "5h", "daily", "seven_day_haiku", "extra_usage", ""],
  },
  {
    name: "ResetSource",
    schema: ResetSource,
    valid: ["provider-reported", "estimated", "unknown"],
    invalid: ["provider", "estimate", "guess", "", "reported"],
  },
  {
    name: "UtilizationSource",
    schema: UtilizationSource,
    valid: ["continuous", "threshold-triggered", "none"],
    invalid: ["threshold", "triggered", "null", "polled", ""],
  },
  {
    name: "ProviderId",
    schema: ProviderId,
    valid: [
      "anthropic-oauth",
      "anthropic-api",
      "openai-oauth",
      "openai-api",
      "openrouter",
      "zai",
      "kimi",
      "minimax",
      "gemini",
      "openai-compatible",
      "anthropic-compatible",
    ],
    invalid: ["anthropic", "openai", "claude-max", "z.ai", "ANTHROPIC-API", ""],
  },
  {
    name: "AuthKind",
    schema: AuthKind,
    valid: ["oauth", "api-key"],
    invalid: ["api_key", "apiKey", "sdk", "none", ""],
  },
] as const

describe("domain enums", () => {
  for (const { name, schema, valid, invalid } of enums) {
    test(`${name} accepts exactly its declared members`, () => {
      expect([...schema.options].sort()).toEqual([...valid].sort())

      for (const member of valid) {
        expect(schema.parse(member)).toBe(member)
      }
    })

    test(`${name} rejects anything else`, () => {
      for (const value of invalid) {
        expect(schema.safeParse(value).success).toBe(false)
      }
      expect(schema.safeParse(undefined).success).toBe(false)
      expect(schema.safeParse(null).success).toBe(false)
      expect(schema.safeParse(1).success).toBe(false)
    })
  }
})

describe("RoutingPolicy", () => {
  test("has exactly six policies", () => {
    expect(RoutingPolicy.options).toHaveLength(6)
  })

  test("defaults to sticky", () => {
    expect(DEFAULT_ROUTING_POLICY).toBe("sticky")
    expect(RoutingPolicy.parse(DEFAULT_ROUTING_POLICY)).toBe("sticky")
  })
})

describe("AccountStatus", () => {
  test("keeps cooling_down and exhausted as separate members", () => {
    expect(AccountStatus.parse("cooling_down")).not.toBe(AccountStatus.parse("exhausted"))
    expect(AccountStatus.options).toContain("cooling_down")
    expect(AccountStatus.options).toContain("exhausted")
  })
})

describe("QuotaWindowState", () => {
  const lastCheckedAt = new Date("2026-07-24T10:00:00.000Z")

  test("accepts a continuous reading with a provider-reported reset", () => {
    const parsed = QuotaWindowState.parse({
      window: "five_hour",
      utilization: 0.42,
      utilizationSource: "continuous",
      resetsAt: new Date("2026-07-24T14:00:00.000Z"),
      resetSource: "provider-reported",
      lastCheckedAt,
    })

    expect(parsed.window).toBe("five_hour")
    expect(parsed.utilization).toBe(0.42)
    expect(parsed.resetSource).toBe("provider-reported")
  })

  test("accepts an absent utilization from a threshold-triggered source", () => {
    const parsed = QuotaWindowState.parse({
      window: "seven_day_opus",
      utilizationSource: "threshold-triggered",
      resetSource: "unknown",
      lastCheckedAt,
    })

    expect(parsed.utilization).toBeUndefined()
    expect(parsed.resetsAt).toBeUndefined()
  })

  test("requires the two source fields — a reading without provenance is not a reading", () => {
    const missingUtilizationSource = QuotaWindowState.safeParse({
      window: "seven_day",
      utilization: 0.9,
      resetSource: "estimated",
      lastCheckedAt,
    })
    const missingResetSource = QuotaWindowState.safeParse({
      window: "seven_day",
      utilizationSource: "continuous",
      lastCheckedAt,
    })

    expect(missingUtilizationSource.success).toBe(false)
    expect(missingResetSource.success).toBe(false)
  })

  test("rejects an out-of-range utilization and a bad window", () => {
    const tooHigh = QuotaWindowState.safeParse({
      window: "five_hour",
      utilization: 1.5,
      utilizationSource: "continuous",
      resetSource: "estimated",
      lastCheckedAt,
    })
    const negative = QuotaWindowState.safeParse({
      window: "five_hour",
      utilization: -0.1,
      utilizationSource: "continuous",
      resetSource: "estimated",
      lastCheckedAt,
    })
    const badWindow = QuotaWindowState.safeParse({
      window: "hourly",
      utilizationSource: "none",
      resetSource: "unknown",
      lastCheckedAt,
    })

    expect(tooHigh.success).toBe(false)
    expect(negative.success).toBe(false)
    expect(badWindow.success).toBe(false)
  })
})
