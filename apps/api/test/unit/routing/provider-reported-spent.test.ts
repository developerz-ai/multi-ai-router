import { describe, expect, test } from "bun:test"
import { providerReportedSpent } from "../../../src/services/routing/cooldown-recheck"
import { account, at, NOW, window } from "./fixtures"

// Plan 101, 10.8: the rule `cooldown_recheck` consults before a 2xx probe may reopen an account.
describe("providerReportedSpent", () => {
  const week = (overrides: Parameters<typeof window>[1] = {}) =>
    window("seven_day", {
      utilization: 1,
      utilizationSource: "continuous",
      resetSource: "provider-reported",
      resetsAt: at(5 * 86_400_000),
      ...overrides,
    })

  test("a spent provider-reported window with a future reset holds the account", () => {
    expect(providerReportedSpent(account("go", { quotaWindows: [week()] }), NOW, 1)).toBe(true)
  })

  test("an estimated, past or unspent window does not", () => {
    for (const quota of [
      week({ resetSource: "estimated" }),
      week({ resetsAt: at(-1) }),
      week({ utilization: 0.4 }),
    ])
      expect(providerReportedSpent(account("go", { quotaWindows: [quota] }), NOW, 1)).toBe(false)
    expect(providerReportedSpent(account("go"), NOW, 1)).toBe(false)
  })
})
