import { describe, expect, test } from "bun:test"
import { findSpentWindow, windowCoversModel } from "../../../src/services/routing"
import {
  cooldownRecheckDue,
  providerReportedSpent,
  readingReopened,
} from "../../../src/services/routing/cooldown-recheck"
import {
  accountIsLiveHealthy,
  recoveryAllowsQuota,
  recoveryAwaitsProbe,
} from "../../../src/services/routing/recovery-filter"
import { account, at, continuous, NOW, window } from "./fixtures"

// `05-routing-and-failover.md` T3: a spent Opus window blocks Opus, not the account. Every question
// asked of the account as a whole (live health, recovery, the recheck) must read it that way too,
// or a Sonnet request is admitted by the filter and refused by the guard behind it.
const opusSpent = account("a", {
  quotaWindows: [
    window("seven_day_opus", {
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: at(2 * 86_400_000),
      resetSource: "provider-reported",
    }),
  ],
})

describe("a model family's window", () => {
  test("meters its family and nothing else; with no model named it meters nothing", () => {
    expect(windowCoversModel("seven_day_opus", "claude-opus-5")).toBe(true)
    expect(windowCoversModel("seven_day_opus", "claude-sonnet-5-5")).toBe(false)
    expect(windowCoversModel("seven_day_sonnet", "claude-sonnet-5-5")).toBe(true)
    expect(windowCoversModel("seven_day_sonnet", "claude-haiku-4-5")).toBe(false)
    expect(windowCoversModel("seven_day_opus")).toBe(false)
    for (const kind of ["five_hour", "seven_day", "overage", "spend_limit"] as const) {
      expect(windowCoversModel(kind)).toBe(true)
      expect(windowCoversModel(kind, "anything")).toBe(true)
    }
  })

  test("is found spent only for a model it meters", () => {
    expect(findSpentWindow(opusSpent, NOW, 1, "claude-opus-5")?.window).toBe("seven_day_opus")
    expect(findSpentWindow(opusSpent, NOW, 1, "claude-sonnet-5-5")).toBeNull()
    expect(findSpentWindow(opusSpent, NOW)).toBeNull()
  })

  test("does not make the account unhealthy, awaiting no probe, or due for a recheck", () => {
    expect(accountIsLiveHealthy(opusSpent, NOW, 1)).toBe(true)
    expect(cooldownRecheckDue(opusSpent, NOW, 3_600_000, 1)).toBe(false)
    expect(providerReportedSpent(opusSpent, NOW, 1)).toBe(false)
    const failed = {
      ...opusSpent,
      recovery: {
        revision: 1,
        generation: "g",
        lifecycleVersion: 1,
        state: "failed" as const,
        nextAllowedAt: at(-1),
        quotaRevisions: {},
      },
    }
    expect(recoveryAwaitsProbe(failed, NOW, 1)).toBe(true)
  })

  test("does not keep a reread from reopening the account", () => {
    const reread = {
      ...opusSpent,
      quotaWindows: [
        ...(opusSpent.quotaWindows ?? []),
        { ...continuous(0.3, "seven_day"), lastCheckedAt: at(1) },
      ],
    }
    expect(readingReopened(opusSpent, reread, NOW, 1)).toBe(true)
  })

  test("a recovery permit is not withheld over a window the model does not draw on", () => {
    const permitted = {
      ...opusSpent,
      recovery: {
        revision: 1,
        generation: "g",
        lifecycleVersion: 1,
        state: "issued" as const,
        nextAllowedAt: at(-1),
        quotaRevisions: {},
        localAvailable: true,
      },
    }
    expect(recoveryAllowsQuota(permitted, NOW, 1, "claude-sonnet-5-5")).toBe(true)
    expect(recoveryAllowsQuota(permitted, NOW, 1)).toBe(true)
    expect(recoveryAllowsQuota(permitted, NOW, 1, "claude-opus-5")).toBe(false)
  })
})
