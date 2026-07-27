import { describe, expect, test } from "bun:test"
import type { UsageGroupRow, UsageOutcomeCount, UsageTotals } from "@multi-ai-router/db"
import {
  createUsageService,
  EMPTY_FAILURES,
  resolveWindow,
  usageWindowQuery,
} from "../../../src/services/usage-read"

/**
 * The usage read surface.
 *
 * Two properties carry the weight here. A window is a pure function of `now`, so the totals and
 * the series can never be built from two different readings of the clock. And a breakdown row
 * whose subject has been deleted still renders — usage rows outlive the keys and accounts they
 * name, so dropping them would make the breakdowns stop adding up to the totals shown beside them.
 */

const NOW = new Date("2026-03-15T14:30:00.000Z")

const ZERO: UsageTotals = {
  requests: 0,
  attempts: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: "0",
  costNotional: "0",
}

function groupRow(id: string | null): UsageGroupRow {
  return { id, ...ZERO, latencyP50Ms: null, latencyP95Ms: null, routerOverheadP95Ms: null }
}

interface Stub {
  /** The per-outcome scan behind the failure split. Empty unless a case cares. */
  readonly outcomes?: readonly UsageOutcomeCount[]
  /** The stitched total the split is folded against, for the `partial` rule. */
  readonly totals?: UsageTotals
}

function service(rows: readonly UsageGroupRow[], stub: Stub = {}) {
  return createUsageService({
    usage: {
      totals: async () => stub.totals ?? ZERO,
      latency: async () => ({
        p50Ms: null,
        p95Ms: null,
        routerOverheadP95Ms: null,
        ttfbP95Ms: null,
      }),
      series: async () => [],
      seriesByDimension: async () => [],
      breakdown: async () => [...rows],
      outcomes: async () => [...(stub.outcomes ?? [])],
    },
    // The live feed is its own read and its own test file; a summary that
    // touched it would be reading rows no chart on the screen plots.
    recent: {
      recent: async () => {
        throw new Error("the summary must not read raw attempt rows")
      },
    },
    // Every case below asks for `today`, which has no closed days — the rolled
    // side is never consulted, and saying so with a throw keeps it that way.
    daily: {
      totals: async () => {
        throw new Error("the rolled table must not be read for a same-day window")
      },
      breakdown: async () => {
        throw new Error("the rolled table must not be read for a same-day window")
      },
    },
    scheduledTasks: { lastSuccess: async () => undefined },
    labels: async () => ({
      keys: new Map([["key-1", "dev-laptops"]]),
      accounts: new Map([["acct-1", "claude-max-01"]]),
      pools: new Map([["pool-1", "default"]]),
    }),
    now: () => NOW,
  })
}

describe("window resolution", () => {
  test("today runs to now, not to the end of the day", () => {
    const window = resolveWindow({ window: "today" }, NOW)

    expect(window.from.toISOString()).toBe("2026-03-15T00:00:00.000Z")
    // Including the rest of an unfinished day would make every morning read as a collapse.
    expect(window.to).toBe(NOW)
    expect(window.bucket).toBe("hour")
  })

  test("a long window buckets by day, a short custom range by hour", () => {
    expect(resolveWindow({ window: "30d" }, NOW).bucket).toBe("day")
    // Chosen from the span, not the name: a 3-hour custom range in day buckets is a single bar.
    expect(
      resolveWindow({ from: "2026-03-15T09:00:00.000Z", to: "2026-03-15T12:00:00.000Z" }, NOW)
        .bucket,
    ).toBe("hour")
  })

  test("a named window and a custom range are mutually exclusive", () => {
    expect(usageWindowQuery.safeParse({ window: "7d", from: NOW.toISOString() }).success).toBe(
      false,
    )
  })

  test("a custom range needs both ends", () => {
    expect(usageWindowQuery.safeParse({ from: NOW.toISOString() }).success).toBe(false)
    expect(
      usageWindowQuery.safeParse({ from: NOW.toISOString(), to: NOW.toISOString() }).success,
    ).toBe(true)
  })
})

describe("breakdown labelling", () => {
  test("a known id gets its name", async () => {
    const result = await service([groupRow("key-1")]).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.byKey[0]).toMatchObject({ id: "key-1", label: "dev-laptops", note: null })
  })

  test("a deleted subject still renders, marked deleted", async () => {
    const result = await service([groupRow("key-gone")]).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Dropping the row would make the breakdown disagree with the total printed above it.
    expect(result.value.byKey).toHaveLength(1)
    expect(result.value.byKey[0]).toMatchObject({ id: "key-gone", label: null, note: "deleted" })
  })

  test("a null id means the dimension did not apply, which is not the same as deleted", async () => {
    const result = await service([groupRow(null)]).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A key scoped `all` was placed by no pool at all.
    expect(result.value.byPool[0]).toMatchObject({ id: null, label: null, note: "none" })
  })

  test("a model is its own label and is never marked deleted", async () => {
    const result = await service([groupRow("glm-4.7")]).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.byModel[0]).toMatchObject({ id: "glm-4.7", label: "glm-4.7", note: null })
  })
})

/**
 * The split rides on the summary rather than on a second endpoint: it answers a
 * question about a number already on the screen, and a separate fetch for it
 * would let the tile and its own breakdown be read from two different windows.
 */
describe("the failure split", () => {
  test("rides on the summary, with quota and credits as two numbers", async () => {
    const result = await service([], {
      outcomes: [
        { outcome: "success", attempts: 90 },
        { outcome: "quota_exhausted", attempts: 7 },
        { outcome: "credits_exhausted", attempts: 3 },
      ],
      totals: { ...ZERO, attempts: 100 },
    }).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.failures.errors).toBe(10)
    expect(result.value.failures.byOutcome).toEqual([
      { outcome: "quota_exhausted", attempts: 7 },
      { outcome: "credits_exhausted", attempts: 3 },
    ])
    expect(result.value.failures.partial).toBe(false)
  })

  test("is folded against the summary's own total, so it can say when it is a floor", async () => {
    // The rollup counted a thousand attempts; the raw rows behind the split hold a hundred.
    const result = await service([], {
      outcomes: [
        { outcome: "success", attempts: 98 },
        { outcome: "upstream_timeout", attempts: 2 },
      ],
      totals: { ...ZERO, attempts: 1000 },
    }).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.failures.attempts).toBe(100)
    expect(result.value.failures.partial).toBe(true)
  })

  test("a quiet window is an empty split, not a missing field", async () => {
    const result = await service([]).summary({ window: "today" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.failures).toEqual(EMPTY_FAILURES)
  })
})
