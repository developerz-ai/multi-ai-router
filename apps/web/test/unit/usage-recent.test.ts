import { describe, expect, test } from "bun:test"
import { UsageFault, UsageOutcome, usageOutcomeFault } from "@multi-ai-router/core"
import {
  faultLabel,
  faultToken,
  outcomeLabel,
  RECENT_FILTERS,
  RECENT_LIMIT_DEFAULT,
  RECENT_OUTCOME_FILTERS,
  type RecentFilter,
  recentFilterLabel,
  recentQueryParams,
  safeRecentLimit,
} from "../../src/lib/api/usage-recent"

/**
 * The live feed's client half — and the drift gate that lets it stay Zod-free.
 *
 * The console imports core **as a type only**, because one runtime import of core's Zod-backed
 * vocabulary pulls Zod into the usage route's chunk (measured: 12 kB → 72 kB). The safety that
 * buys back is here rather than at runtime: this file *may* import core, because tests are not
 * bundled, so it can assert that the restated filter list is exactly core's and that every outcome
 * the router can record has a presentation. That is the same arrangement `account-status.test.ts`
 * has for `AccountStatus`.
 */

describe("the filter list", () => {
  test("is exactly core's outcomes — no member missing, none invented", () => {
    // The drift gate. An outcome added to core without a filter entry fails here, not in a support
    // ticket where an operator cannot find the failure they are looking at.
    expect([...RECENT_OUTCOME_FILTERS].sort()).toEqual([...UsageOutcome.options].sort())
  })

  test("offers the two coarse views ahead of the specific ones", () => {
    expect(RECENT_FILTERS).toEqual(["all", "failed", ...RECENT_OUTCOME_FILTERS])
  })

  test("keeps quota and credits separately selectable", () => {
    // Non-negotiable 7: one is a window a clock refills, the other needs a human.
    expect(RECENT_FILTERS).toContain("quota_exhausted")
    expect(RECENT_FILTERS).toContain("credits_exhausted")
    expect(recentFilterLabel("quota_exhausted")).not.toBe(recentFilterLabel("credits_exhausted"))
  })

  test("labels read as words, never as an enum member", () => {
    expect(recentFilterLabel("all")).toBe("Everything")
    expect(recentFilterLabel("failed")).toBe("Failures only")
    expect(outcomeLabel("upstream_timeout")).toBe("upstream timeout")
  })
})

describe("query params", () => {
  const base = { limit: 50, filter: "all" as RecentFilter, requestId: null }

  test("everything sends no filter at all", () => {
    expect(recentQueryParams(base)).toEqual({
      limit: "50",
      failed: undefined,
      outcome: undefined,
      requestId: undefined,
    })
  })

  test("failures only sends the flag, never an outcome beside it", () => {
    const params = recentQueryParams({ ...base, filter: "failed" })

    // The server answers 400 to both together, and this is the one place that could send them.
    expect(params.failed).toBe("true")
    expect(params.outcome).toBeUndefined()
  })

  test("a named outcome sends the outcome, never the flag beside it", () => {
    const params = recentQueryParams({ ...base, filter: "credits_exhausted" })

    expect(params.outcome).toBe("credits_exhausted")
    expect(params.failed).toBeUndefined()
  })

  test("a request id rides along verbatim, either kind", () => {
    expect(recentQueryParams({ ...base, requestId: "req-42" }).requestId).toBe("req-42")
    const uuid = "11111111-1111-4111-8111-111111111111"
    expect(recentQueryParams({ ...base, requestId: uuid }).requestId).toBe(uuid)
  })

  test("a limit outside the accepted range falls back rather than being sent and rejected", () => {
    expect(safeRecentLimit(1000)).toBe(RECENT_LIMIT_DEFAULT)
    expect(safeRecentLimit(0)).toBe(RECENT_LIMIT_DEFAULT)
    expect(safeRecentLimit(12.5)).toBe(RECENT_LIMIT_DEFAULT)
    expect(safeRecentLimit(200)).toBe(200)
  })
})

describe("fault presentation", () => {
  test("every fault group has a token and a word — no default, no blank", () => {
    for (const fault of UsageFault.options) {
      expect(faultToken(fault)).toMatch(/^--/)
      expect(faultLabel(fault).length).toBeGreaterThan(0)
    }
  })

  test("a served attempt and a broken router never share a token", () => {
    expect(faultToken("none")).toBe("--ok")
    expect(faultToken("router")).toBe("--danger")
    expect(faultToken("upstream")).toBe("--danger")
    // Capacity is a warning, not a failure of ours: a window resets, a balance is topped up.
    expect(faultToken("capacity")).toBe("--warn")
  })

  test("every fault the router can put on a row resolves to a token", () => {
    // The wire carries `fault`, resolved by `usageOutcomeFault`. Walking every outcome through it
    // proves the console can render whatever the router sends, with no untinted dot possible.
    for (const outcome of UsageOutcome.options) {
      expect(faultToken(usageOutcomeFault(outcome))).toMatch(/^--/)
      expect(faultLabel(usageOutcomeFault(outcome)).length).toBeGreaterThan(0)
    }
  })
})
