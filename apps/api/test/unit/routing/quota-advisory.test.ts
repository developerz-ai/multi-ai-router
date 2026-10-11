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

  test("the marker is the only thing standing between an at-100% window and a block", () => {
    // Two identical windows except for the marker — one blocks, one does not. Proves the marker
    // is the gate, not anything else about the reading (utilization 1, future reset, continuous).
    const advisory = windowAt({ advisory: true, utilization: 1 })
    expect(isWindowSpent(advisory, NOW)).toBe(false)
    const nonAdvisory = windowAt({ advisory: false, utilization: 1 })
    expect(isWindowSpent(nonAdvisory, NOW)).toBe(true)
  })

  test("an advisory window whose reset has passed still reads as not spent", () => {
    // Even a past reset does not flip an advisory window to blocking — the marker keeps it
    // display-only for the lifetime of the row.
    const pastReset = new Date(NOW.getTime() - 60_000)
    expect(
      isWindowSpent(windowAt({ advisory: true, resetsAt: pastReset, utilization: 0.95 }), NOW),
    ).toBe(false)
  })
})
