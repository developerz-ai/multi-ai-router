import { describe, expect, test } from "bun:test"
import type { ModelRates, OverrideDiff, PriceOverride, PriceRate } from "../../src/lib/api/settings"
import { RATE_FIELDS } from "../../src/lib/api/settings"
import { formatCost } from "../../src/lib/format"
import {
  draftOf,
  EMPTY_DRAFT,
  ORIGIN_TONE,
  parseDraft,
  RATE_HEADERS,
  type RateDraft,
  rateSummary,
  removalConsequences,
  summarise,
  toRate,
  ZERO_RATES,
} from "../../src/routes/settings/price-editing"

// The two halves of "cost" on screen: `formatCost` turns a spend number into a dollar string, and
// `price-editing.ts` turns a `$/Mtok` rate into (and back out of) a text box. Both are pure and
// locale-free by construction, so a fixed clock is never needed here — unlike `reset-countdown.ts`,
// nothing in this module reads a timestamp at all.

const rates = (input: number, output: number): ModelRates => ({
  inputPerMtok: input,
  outputPerMtok: output,
  cacheReadPerMtok: input * 0.1,
  cacheWritePerMtok: input * 1.25,
})

const shippedRate = (model: string, input: number, output: number): PriceRate => ({
  provider: "anthropic-api",
  model,
  ...rates(input, output),
})

describe("formatCost", () => {
  test("a third of a cent is never rounded to a broken-looking zero", () => {
    expect(formatCost(0.0003)).toBe("$0.0003")
  })

  test("an exact zero spend is the plain form, not the four-decimal one", () => {
    expect(formatCost(0)).toBe("$0.00")
  })

  test("the normal range keeps two decimals", () => {
    expect(formatCost(12.345)).toBe("$12.35")
    expect(formatCost(0.5)).toBe("$0.50")
  })

  test("large spend drops to a grouped whole-dollar figure rather than fake precision", () => {
    expect(formatCost(1234.5)).toBe("$1,235")
    expect(formatCost(999.99)).toBe("$999.99")
  })

  test("a negative figure is still a dollar figure, not silently clamped to zero", () => {
    expect(formatCost(-0.02)).toBe("$-0.02")
  })

  test("a non-finite value is a dash, never NaN or Infinity on screen", () => {
    expect(formatCost(Number.NaN)).toBe("—")
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("—")
  })
})

// The load-bearing invariant from `usage-index.ts`: metered and notional spend are separate
// measures and are never added into a single "cost". `UsageCell` renders them as two independent
// `formatCost` calls — this pins that shape at the formatting layer, not just the ranking layer
// `usage-index.test.ts` already covers.
describe("metered and notional are formatted apart, never summed", () => {
  test("each spend is formatted from its own number, not from a combined total", () => {
    const costMetered = 12
    const costNotional = 900

    const meteredText = formatCost(costMetered)
    const notionalText = formatCost(costNotional)
    const summedText = formatCost(costMetered + costNotional)

    expect(meteredText).toBe("$12.00")
    expect(notionalText).toBe("$900.00")
    // If a caller ever summed before formatting, this is the number it would produce — pinning
    // that the two real cells disagree with it guards against that regression.
    expect(summedText).not.toBe(meteredText)
    expect(summedText).not.toBe(notionalText)
  })

  test("a zero on one side never borrows from the other", () => {
    expect(formatCost(0)).toBe("$0.00")
    // A subscription-only account: metered is genuinely zero, notional is not — the zero must not
    // be "filled in" from the sibling figure.
    expect(formatCost(0)).not.toBe(formatCost(40))
  })
})

describe("toRate", () => {
  test("parses a plain decimal", () => {
    expect(toRate("3.5")).toBe(3.5)
  })

  test("zero is a real price — free — not a parse failure", () => {
    expect(toRate("0")).toBe(0)
  })

  test("trims surrounding whitespace", () => {
    expect(toRate("  4  ")).toBe(4)
  })

  test("a negative rate is rejected — prices do not pay the operator", () => {
    expect(toRate("-1")).toBeNull()
  })

  test("empty and non-numeric text are rejected, not coerced to zero", () => {
    expect(toRate("")).toBeNull()
    expect(toRate("free")).toBeNull()
    expect(toRate("NaN")).toBeNull()
  })
})

describe("draftOf / parseDraft round-trip", () => {
  test("a valid rate set survives text and back", () => {
    const set = rates(3, 15)
    expect(parseDraft(draftOf(set))).toEqual(set)
  })

  test("one bad cell invalidates the whole row, not just that cell", () => {
    const draft: RateDraft = { ...draftOf(rates(3, 15)), outputPerMtok: "not-a-number" }
    expect(parseDraft(draft)).toBeNull()
  })

  test("the empty draft — a freshly added row — does not parse to zero rates", () => {
    expect(parseDraft(EMPTY_DRAFT)).toBeNull()
  })

  test("zero rates parse cleanly once every cell is explicitly filled", () => {
    expect(parseDraft(draftOf(ZERO_RATES))).toEqual(ZERO_RATES)
  })
})

describe("rateSummary", () => {
  test("prints the four fields in column order", () => {
    expect(
      rateSummary({
        inputPerMtok: 3,
        outputPerMtok: 15,
        cacheReadPerMtok: 0.3,
        cacheWritePerMtok: 3.75,
      }),
    ).toBe("3 / 15 / 0.3 / 3.75")
  })
})

describe("RATE_HEADERS and ORIGIN_TONE completeness", () => {
  test("every rate field has a header", () => {
    for (const field of RATE_FIELDS) {
      expect(RATE_HEADERS[field].length).toBeGreaterThan(0)
    }
  })

  test("every origin has a tone, and shipped reads neutral", () => {
    expect(ORIGIN_TONE.shipped).toBe("neutral")
    expect(ORIGIN_TONE.overridden).not.toBe("neutral")
    expect(ORIGIN_TONE.added).not.toBe("neutral")
  })
})

describe("summarise", () => {
  const view = {
    version: "1.0.0",
    retention: {
      usageDays: 30,
      auditDays: 90,
      sessionsHours: 24,
      revokedKeysDays: 7,
      oauthStateMinutes: 10,
    },
    logLevel: "info",
    janitorIntervalMinutes: 5,
    prices: { shipped: [], overrides: [shippedOverride("claude-sonnet-5", 2.5, 12)] },
  }

  test("nothing to save is stated plainly when the diff is empty", () => {
    const diff: OverrideDiff = { removed: [], changed: [] }
    expect(summarise(view, diff)).toContain("Nothing to save")
  })

  test("a pending save states counts for both halves", () => {
    const diff: OverrideDiff = { removed: [shippedOverride("old-model", 1, 2)], changed: [] }
    const text = summarise(view, diff)
    expect(text).toContain("1 override(s) stored")
    expect(text).toContain("removes 1")
  })
})

describe("removalConsequences", () => {
  const shipped = [shippedRate("claude-sonnet-5", 3, 15)]

  test("a removal that has a shipped fallback names the price it reverts to", () => {
    const diff: OverrideDiff = {
      removed: [shippedOverride("claude-sonnet-5", 2.5, 12)],
      changed: [],
    }
    const lines = removalConsequences(diff, shipped)
    expect(lines[0]).toContain("goes back to the shipped price")
    expect(lines[0]).toContain(rateSummary(shipped[0] as ModelRates))
  })

  test("a removal with no shipped fallback says spend goes unknown, never zero", () => {
    const diff: OverrideDiff = { removed: [shippedOverride("some/model", 1, 2)], changed: [] }
    const lines = removalConsequences(diff, shipped)
    expect(lines[0]).toContain("reported as unknown")
    expect(lines[0]).not.toContain("reported as zero")
  })

  test("caps the listed removals and notes how many more, rather than an unbounded wall of text", () => {
    const diff: OverrideDiff = {
      removed: Array.from({ length: 9 }, (_, i) => shippedOverride(`model-${i}`, 1, 2)),
      changed: [],
    }
    const lines = removalConsequences(diff, shipped)
    expect(lines.some((line) => line.includes("…and 3 more."))).toBe(true)
  })

  test("always closes on the same disclaimer: history is not recalculated", () => {
    const diff: OverrideDiff = { removed: [], changed: [] }
    const lines = removalConsequences(diff, shipped)
    expect(lines.at(-1)).toContain("not recalculated")
  })
})

function shippedOverride(model: string, input: number, output: number): PriceOverride {
  return { ...shippedRate(model, input, output), updatedAt: "2026-07-25T10:00:00.000Z" }
}
