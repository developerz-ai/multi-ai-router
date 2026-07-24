import { describe, expect, test } from "bun:test"
import {
  AccountStatus,
  KeyScope,
  ProviderId,
  ResetSource,
  RoutingPolicy,
  UtilizationSource,
} from "@multi-ai-router/core"
import {
  accountStatus,
  costBasis,
  keyScope,
  providerId,
  resetSource,
  routingPolicy,
  scheduledTask,
  scheduledTaskOutcome,
  utilizationSource,
} from "../../src/schema/enums"
import { quotaWindows } from "../../src/schema/quota-windows"
import { usageRecords } from "../../src/schema/usage-records"

describe("postgres enums track @multi-ai-router/core", () => {
  test("every shared enum is built from core's option list, in order", () => {
    expect(providerId.enumValues).toEqual(ProviderId.options)
    expect(accountStatus.enumValues).toEqual(AccountStatus.options)
    expect(routingPolicy.enumValues).toEqual(RoutingPolicy.options)
    expect(keyScope.enumValues).toEqual(KeyScope.options)
    expect(utilizationSource.enumValues).toEqual(UtilizationSource.options)
    expect(resetSource.enumValues).toEqual(ResetSource.options)
  })
})

describe("closed sets are enums, open labels are text", () => {
  test("a quota window kind is text — providers define their own windows", () => {
    // Typed against core's QuotaWindowKind, but observing a window we have not
    // seen must cost a core change, not a core change plus a migration.
    expect(quotaWindows.window.getSQLType()).toBe("text")
    expect(quotaWindows.window.notNull).toBe(true)
  })

  test("an attempt outcome is text, for the same reason", () => {
    expect(usageRecords.outcome.getSQLType()).toBe("text")
  })

  test("the sets where an unknown value is a bug stay real postgres enums", () => {
    for (const enumType of [
      providerId,
      accountStatus,
      routingPolicy,
      keyScope,
      utilizationSource,
      resetSource,
    ]) {
      expect(enumType.enumValues.length).toBeGreaterThan(0)
    }
  })
})

describe("documented enum values", () => {
  test("account status is exactly the five documented states", () => {
    expect(accountStatus.enumValues).toEqual([
      "active",
      "disabled",
      "cooling_down",
      "exhausted",
      "needs_reauth",
    ])
  })

  test("exhausted is a state of its own, never folded into cooling_down", () => {
    // A clock fixes `cooling_down`; only a human fixes `exhausted`. Losing this
    // distinction makes the router retry a dead account on a timer.
    expect(accountStatus.enumValues).toContain("exhausted")
    expect(accountStatus.enumValues).toContain("cooling_down")
  })

  test("routing policy is exactly the six pool policies, sticky first", () => {
    expect(routingPolicy.enumValues).toEqual([
      "sticky",
      "round-robin",
      "weighted",
      "least-used",
      "priority-failover",
      "quota-aware",
    ])
  })

  test("provider ids keep anthropic-oauth and anthropic-api separate", () => {
    expect(providerId.enumValues).toHaveLength(11)
    expect(providerId.enumValues).toContain("anthropic-oauth")
    expect(providerId.enumValues).toContain("anthropic-api")
  })

  test("key scope is all | pools | accounts", () => {
    expect(keyScope.enumValues).toEqual(["all", "pools", "accounts"])
  })

  test("utilization and reset sources are carried, and separate", () => {
    expect(utilizationSource.enumValues).toEqual(["continuous", "threshold-triggered", "none"])
    expect(resetSource.enumValues).toEqual(["provider-reported", "estimated", "unknown"])
  })

  test("cost basis separates metered from notional spend", () => {
    expect(costBasis.enumValues).toEqual(["metered", "notional", "unknown"])
  })

  test("scheduled tasks and their outcomes are enumerated", () => {
    expect(scheduledTask.enumValues).toEqual([
      "janitor_sweep",
      "usage_rollup",
      "oauth_state_purge",
      "quota_floor_refresh",
    ])
    expect(scheduledTaskOutcome.enumValues).toEqual(["success", "failed", "partial"])
  })
})
