import { describe, expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import { type AttemptFailure, spentPlanReset, withPlanReset } from "../../../src/services/routing"

/**
 * A limit refusal that names no reset borrows the spent plan window's. Prod fingerprint, 2026-11-06:
 * the `minimax` account answered `429 … (2056)` with no reset, cooled five minutes at a time (92
 * consecutive failures, `resetSource: estimated`) while its own usage endpoint said the weekly
 * window reopened at 2026-11-09T00:00Z.
 */

const NOW = new Date("2026-11-06T23:02:36.000Z")
const WEEKLY_RESET = new Date("2026-11-09T00:00:00.000Z")
const FIVE_HOUR_RESET = new Date("2026-11-07T00:00:00.000Z")

function window(overrides: Partial<QuotaWindowState> = {}): QuotaWindowState {
  return {
    window: "seven_day",
    utilization: 1,
    utilizationSource: "continuous",
    resetsAt: WEEKLY_RESET,
    resetSource: "provider-reported",
    lastCheckedAt: NOW,
    advisory: true,
    ...overrides,
  }
}

const token2056: AttemptFailure = {
  kind: "rate-limited",
  status: 429,
  message: "Token Plan usage limit reached (2056)",
}

describe("withPlanReset, failure case first", () => {
  test("a reset-less 429 on a spent weekly window cools until the window's own reset", () => {
    const planned = withPlanReset(token2056, [window()], NOW)
    expect(planned.resetsAt).toEqual(WEEKLY_RESET)
    expect(planned.resetSource).toBe("provider-reported")
  })

  test("an estimated re-test cadence (Kimi's 403) gives way to the provider's reset", () => {
    const kimi: AttemptFailure = {
      kind: "rate-limited",
      status: 403,
      retryAfterSeconds: 3600,
      resetSource: "estimated",
      message: "You've reached your weekly (7-day) usage limit.",
    }
    const planned = withPlanReset(kimi, [window()], NOW)
    expect(planned.resetsAt).toEqual(WEEKLY_RESET)
    expect(planned.retryAfterSeconds).toBeUndefined()
    expect(planned.resetSource).toBe("provider-reported")
  })

  test("with two spent windows the account opens when the later one does", () => {
    const fiveHour = window({ window: "five_hour", resetsAt: FIVE_HOUR_RESET })
    expect(withPlanReset(token2056, [fiveHour, window()], NOW).resetsAt).toEqual(WEEKLY_RESET)
  })
})

describe("withPlanReset leaves everything else alone", () => {
  test("a reset the refusal stated stands, even a shorter one", () => {
    const zai: AttemptFailure = {
      ...token2056,
      resetsAt: FIVE_HOUR_RESET,
      resetSource: "provider-reported",
    }
    expect(withPlanReset(zai, [window()], NOW)).toBe(zai)
  })

  test("a Retry-After the upstream sent stands", () => {
    const stated: AttemptFailure = { ...token2056, retryAfterSeconds: 30 }
    expect(withPlanReset(stated, [window()], NOW)).toBe(stated)
  })

  test("only a rate limit borrows: a server error keeps its backoff", () => {
    const fault: AttemptFailure = { kind: "server-error", status: 500, message: "boom" }
    expect(withPlanReset(fault, [window()], NOW)).toBe(fault)
  })

  test("a window with headroom, an estimated or unknown reset, or a past reset lends nothing", () => {
    for (const held of [
      window({ utilization: 0.99 }),
      window({ resetSource: "estimated" }),
      window({ resetSource: "unknown", resetsAt: undefined }),
      window({ resetsAt: new Date(NOW.getTime() - 1) }),
      window({ utilization: undefined, utilizationSource: "threshold-triggered" }),
      window({ blocksRouting: false }),
    ]) {
      expect(withPlanReset(token2056, [held], NOW)).toBe(token2056)
    }
  })

  test("no windows, no reset", () => {
    expect(spentPlanReset([], NOW)).toBeNull()
  })
})
