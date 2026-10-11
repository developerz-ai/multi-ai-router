import { describe, expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import { isWindowSpent } from "../../../src/services/routing/quota"

/**
 * The Codex usage gauge sets `advisory: true` on every window it builds, because dropping a
 * one-member `openai-luna` pool on a header reading would switch it off for up to seven days on
 * the router's own say-so (the credits headers #185 records are not modelled yet). The marker
 * never blocks routing; a window without it reads the same as before.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z")
const FUTURE = new Date(NOW.getTime() + 3_600_000)

function windowAt(overrides: Partial<QuotaWindowState> = {}): QuotaWindowState {
  return {
    window: "five_hour",
    utilization: 1,
    utilizationSource: "continuous",
    resetsAt: FUTURE,
    resetSource: "provider-reported",
    lastCheckedAt: NOW,
    ...overrides,
  }
}

describe("isWindowSpent — the advisory marker", () => {
  test("a fully-spent window without the marker still reads as spent", () => {
    expect(isWindowSpent(windowAt(), NOW)).toBe(true)
  })

  test("the same shape with the marker never reads as spent, even at utilization 1", () => {
    expect(isWindowSpent(windowAt({ advisory: true }), NOW)).toBe(false)
  })

  test("the marker is sticky across an in-flight reading; a stale non-advisory reading cannot un-mark", () => {
    // The held window was advisory and reported 100% — never blocked. A non-advisory reading
    // that arrives with the same clock does not flip the held result: the overlay code path
    // (`mergeQuotaEvidence`) is its own concern; this file pins the gating function only.
    const advisory = windowAt({ advisory: true, utilization: 1 })
    expect(isWindowSpent(advisory, NOW)).toBe(false)
    // A non-advisory reading for the same window still blocks — proves the marker is the
    // only thing standing between this case and a 100%-block.
    const nonAdvisory = windowAt({ advisory: false, utilization: 1 })
    expect(isWindowSpent(nonAdvisory, NOW)).toBe(true)
  })

  test("an advisory window whose reset has passed still reads as not spent", () => {
    const pastReset = new Date(NOW.getTime() - 60_000)
    expect(
      isWindowSpent(windowAt({ advisory: true, resetsAt: pastReset, utilization: 0.95 }), NOW),
    ).toBe(false)
  })
})
