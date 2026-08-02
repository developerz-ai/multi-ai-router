import { describe, expect, test } from "bun:test"
import type { AccountStatus, QuotaWindowKind } from "@multi-ai-router/core"
import { QuotaWindowKind as QuotaWindowKindSchema } from "@multi-ai-router/core"
import type { QuotaWindowView } from "../../src/lib/api/types"
import {
  describeQuotaWindow,
  describeQuotaWindows,
  formatUtilization,
  parseInstant,
  QUOTA_WINDOW_DISPLAY_ORDER,
  quotaWindowLabel,
  quotaWindowTitle,
  quotaWindowTone,
  utilizationNote,
} from "../../src/lib/quota-windows"

// Per-window quota rendering. Every case here is a rule from
// `docs/idea/05-routing-and-failover.md` rather than a formatting preference — an exhausted
// account that shows a countdown, or a window row with no source label, is a lie the console tells
// an operator who is deciding whether to wait or to reach for a credit card.

const NOW = Date.parse("2026-07-25T12:00:00.000Z")
const IN_AN_HOUR = new Date(NOW + 3_600_000).toISOString()
const AN_HOUR_AGO = new Date(NOW - 3_600_000).toISOString()

function window(overrides: Partial<QuotaWindowView> = {}): QuotaWindowView {
  return {
    window: "five_hour",
    utilization: 0.62,
    utilizationSource: "continuous",
    resetsAt: IN_AN_HOUR,
    resetSource: "provider-reported",
    lastCheckedAt: new Date(NOW).toISOString(),
    spent: false,
    ...overrides,
  }
}

describe("the display order", () => {
  test("is a permutation of every window core defines", () => {
    expect([...QUOTA_WINDOW_DISPLAY_ORDER].sort()).toEqual(
      [...QuotaWindowKindSchema.options].sort(),
    )
  })

  test("puts the shortest window first and overage last", () => {
    expect(QUOTA_WINDOW_DISPLAY_ORDER[0]).toBe("five_hour")
    expect(QUOTA_WINDOW_DISPLAY_ORDER.at(-1)).toBe("overage")
  })

  test("names and titles every window core defines", () => {
    for (const kind of QuotaWindowKindSchema.options) {
      expect(quotaWindowLabel(kind as QuotaWindowKind).length).toBeGreaterThan(0)
      expect(quotaWindowTitle(kind as QuotaWindowKind).length).toBeGreaterThan(0)
    }
  })
})

describe("describeQuotaWindows", () => {
  test("returns the windows in reading order, whatever order they arrived in", () => {
    const rows = describeQuotaWindows(
      {
        status: "active",
        windows: [
          window({ window: "overage" }),
          window({ window: "seven_day_sonnet" }),
          window({ window: "five_hour" }),
        ],
      },
      NOW,
    )

    expect(rows.map((row) => row.window)).toEqual(["five_hour", "seven_day_sonnet", "overage"])
  })

  test("invents no row for a window this account did not report", () => {
    const rows = describeQuotaWindows({ status: "active", windows: [window()] }, NOW)
    expect(rows).toHaveLength(1)
  })

  test("returns nothing for an account with no windows at all", () => {
    expect(describeQuotaWindows({ status: "active", windows: [] }, NOW)).toEqual([])
  })
})

describe("an exhausted account", () => {
  const EXHAUSTED: AccountStatus = "exhausted"

  test("shows needs top-up on a window row, never a countdown", () => {
    const row = describeQuotaWindow(EXHAUSTED, window({ resetsAt: IN_AN_HOUR }), NOW)

    expect(row.reset.kind).toBe("needs_topup")
    expect(row.reset.countdown).toBeNull()
    expect(row.reset.text).toContain("top-up")
  })

  test("drops the absolute instant too, so nothing on the row promises a reset", () => {
    const row = describeQuotaWindow(EXHAUSTED, window({ resetsAt: IN_AN_HOUR }), NOW)
    expect(row.resetsAtMs).toBeNull()
  })

  test("suppresses the countdown on every window, not just the spent one", () => {
    const rows = describeQuotaWindows(
      {
        status: EXHAUSTED,
        windows: [window({ window: "five_hour" }), window({ window: "seven_day", spent: true })],
      },
      NOW,
    )

    expect(rows.every((row) => row.reset.countdown === null)).toBe(true)
    expect(rows.every((row) => row.resetsAtMs === null)).toBe(true)
  })
})

describe("a cooling account", () => {
  test("carries both halves of the reset: countdown and absolute instant", () => {
    const row = describeQuotaWindow("cooling_down", window({ resetsAt: IN_AN_HOUR }), NOW)

    expect(row.reset.kind).toBe("countdown")
    expect(row.reset.countdown).toBe("1h")
    expect(row.resetsAtMs).toBe(Date.parse(IN_AN_HOUR))
  })

  test("a window on an *active* account still counts down — it refills on its own clock", () => {
    // The account-level line has nothing to say for a healthy account. A window does: this one is
    // 62% spent and an hour from refilling, and printing "—" beside a moving gauge is a lie of a
    // different kind than an exhausted countdown.
    const row = describeQuotaWindow("active", window({ resetsAt: IN_AN_HOUR }), NOW)

    expect(row.reset.kind).toBe("countdown")
    expect(row.reset.countdown).toBe("1h")
    expect(row.reset.qualifier).toBe("reported")
    expect(row.resetsAtMs).toBe(Date.parse(IN_AN_HOUR))
  })

  test("a window on a needs_reauth account keeps its instant too", () => {
    const row = describeQuotaWindow("needs_reauth", window({ resetsAt: IN_AN_HOUR }), NOW)
    expect(row.reset.kind).toBe("countdown")
  })

  test("reads a reset already in the past as due rather than counting backwards", () => {
    const row = describeQuotaWindow("cooling_down", window({ resetsAt: AN_HOUR_AGO }), NOW)
    expect(row.reset.kind).toBe("due")
    expect(row.reset.countdown).toBeNull()
  })
})

// A printed timestamp is a claim. It may only appear beside a sentence that is about that
// instant — never beside "Unknown", and never beside "needs top-up".
describe("the absolute instant", () => {
  test("is dropped when the source is unknown, however the row was stored", () => {
    const row = describeQuotaWindow(
      "cooling_down",
      window({ resetsAt: IN_AN_HOUR, resetSource: "unknown" }),
      NOW,
    )

    expect(row.reset.kind).toBe("unknown")
    expect(row.resetsAtMs).toBeNull()
  })

  test("survives for the two kinds that are about an instant", () => {
    expect(describeQuotaWindow("active", window({ resetsAt: IN_AN_HOUR }), NOW).resetsAtMs).toBe(
      Date.parse(IN_AN_HOUR),
    )
    expect(describeQuotaWindow("active", window({ resetsAt: AN_HOUR_AGO }), NOW).resetsAtMs).toBe(
      Date.parse(AN_HOUR_AGO),
    )
  })
})

describe("the source label", () => {
  test("is stated on every row, unknown included", () => {
    const rows = describeQuotaWindows(
      {
        status: "cooling_down",
        windows: [
          window({ window: "five_hour", resetSource: "provider-reported" }),
          window({ window: "seven_day", resetSource: "estimated" }),
          window({ window: "overage", resetSource: "unknown", resetsAt: null }),
        ],
      },
      NOW,
    )

    expect(rows.map((row) => row.resetLabel)).toEqual(["reported", "estimated", "unknown"])
  })
})

describe("the utilization reading", () => {
  test("keeps a null reading null rather than collapsing it to zero", () => {
    const row = describeQuotaWindow("active", window({ utilization: null }), NOW)

    expect(row.utilization).toBeNull()
    expect(row.utilizationText).toBe("—")
  })

  test("explains why a threshold-triggered gauge can be empty", () => {
    const row = describeQuotaWindow(
      "active",
      window({ utilization: null, utilizationSource: "threshold-triggered" }),
      NOW,
    )

    expect(row.utilizationNote).toBe(utilizationNote("threshold-triggered"))
    expect(row.utilizationNote).toContain("normal")
  })

  test("an unread window says 'no reading yet', never that the provider cannot signal (#69)", () => {
    const row = describeQuotaWindow(
      "active",
      window({ utilization: null, utilizationSource: "none" }),
      NOW,
    )

    expect(row.utilizationNote).toContain("No reading yet")
    expect(row.utilizationNote).not.toContain("exposes no utilization signal")
  })

  test("an active account with nothing known gets 'no reading yet', not an invented retry (#69)", () => {
    const row = describeQuotaWindow(
      "active",
      window({
        utilization: null,
        utilizationSource: "none",
        resetsAt: null,
        resetSource: "unknown",
      }),
      NOW,
    )

    expect(row.reset.kind).toBe("unknown")
    expect(row.reset.text).toBe("Unknown — no reading yet")
  })

  test("a blocked account with nothing known keeps the honest backoff sentence (#69)", () => {
    const row = describeQuotaWindow(
      "cooling_down",
      window({
        utilization: null,
        utilizationSource: "none",
        resetsAt: null,
        resetSource: "unknown",
      }),
      NOW,
    )

    expect(row.reset.kind).toBe("unknown")
    expect(row.reset.text).toBe("Unknown — will retry with backoff")
  })

  test("never rounds a small non-zero share down to 0%", () => {
    expect(formatUtilization(0.004)).toBe("0.4%")
    expect(formatUtilization(0)).toBe("0%")
  })

  test("never rounds an incomplete window up to 100%", () => {
    expect(formatUtilization(0.996)).toBe("99.6%")
    expect(formatUtilization(1)).toBe("100%")
  })

  test("reads a missing or nonsense value as no reading", () => {
    expect(formatUtilization(null)).toBe("—")
    expect(formatUtilization(Number.NaN)).toBe("—")
  })
})

describe("the tone", () => {
  test("follows the server's spent verdict, not the raw utilization", () => {
    // A window at 1.0 whose reset has already passed is refilled — routing does not treat it as
    // blocking, and neither may the console.
    const refilled = describeQuotaWindow(
      "active",
      window({ utilization: 1, spent: false, resetsAt: AN_HOUR_AGO }),
      NOW,
    )
    const blocking = describeQuotaWindow(
      "cooling_down",
      window({ utilization: 1, spent: true }),
      NOW,
    )

    expect(quotaWindowTone(refilled)).not.toBe("danger")
    expect(quotaWindowTone(blocking)).toBe("danger")
  })

  test("warns before a window is spent, and stays quiet with headroom left", () => {
    expect(quotaWindowTone(describeQuotaWindow("active", window({ utilization: 0.85 }), NOW))).toBe(
      "warn",
    )
    expect(quotaWindowTone(describeQuotaWindow("active", window({ utilization: 0.2 }), NOW))).toBe(
      "neutral",
    )
  })

  test("stays neutral with no reading — an absent signal is not a warning", () => {
    const unread = describeQuotaWindow("active", window({ utilization: null }), NOW)
    expect(quotaWindowTone(unread)).toBe("neutral")
  })
})

/**
 * The bar the console draws when the provider reports nothing — which, for a Claude subscription,
 * is most of every window.
 *
 * The rule that keeps it honest: this is the ROUTER'S measurement against a ceiling the OPERATOR
 * typed, and both halves can be wrong. Anthropic publishes no numeric limit and meters differently
 * than we count. So it renders only when both figures exist, it never overrides a real provider
 * reading, and it says what it is.
 */
describe("the measured fallback bar", () => {
  const measured = (extra: Record<string, unknown>) =>
    describeQuotaWindows(
      {
        status: "active",
        windows: [
          {
            window: "seven_day",
            utilization: null,
            utilizationSource: "threshold-triggered",
            resetsAt: null,
            resetSource: "unknown",
            lastCheckedAt: "2026-07-28T00:00:00.000Z",
            spent: false,
            tokensUsed: null,
            tokenLimit: null,
            ...extra,
          },
        ],
      } as never,
      NOW,
    )[0]

  test("fills from tokens measured against the configured ceiling", () => {
    const row = measured({ tokensUsed: 1_200_000, tokenLimit: 3_000_000 })

    expect(row?.utilization).toBeCloseTo(0.4, 5)
    // Counts, not a bare percentage: a share is meaningless without the ceiling it is a share of.
    expect(row?.utilizationText).toBe("1.2M / 3M")
    expect(row?.utilizationNote).toContain("not a figure the provider reported")
  })

  test("a provider reading always wins over our own arithmetic", () => {
    const row = measured({ utilization: 0.9, tokensUsed: 10, tokenLimit: 3_000_000 })

    expect(row?.utilization).toBe(0.9)
    expect(row?.utilizationText).not.toContain("/")
  })

  test("a ceiling with no count, or a count with no ceiling, draws nothing", () => {
    expect(measured({ tokenLimit: 3_000_000 })?.utilization).toBeNull()
    expect(measured({ tokensUsed: 1_000 })?.utilization).toBeNull()
  })

  /** `undefined` slips past a `!== null` check and turns the division into NaN — a filled bar. */
  test("missing fields do not become a NaN-filled bar", () => {
    const row = measured({ tokensUsed: undefined, tokenLimit: undefined })

    expect(row?.utilization).toBeNull()
    expect(row?.utilizationText).not.toContain("NaN")
  })

  test("overshooting the configured ceiling clamps to full rather than past it", () => {
    expect(measured({ tokensUsed: 9_000_000, tokenLimit: 3_000_000 })?.utilization).toBe(1)
  })

  test("a zero or negative ceiling is not a permanently-spent window", () => {
    expect(measured({ tokensUsed: 10, tokenLimit: 0 })?.utilization).toBeNull()
  })
})

/**
 * The consumption curve beside the bar.
 *
 * Both halves of the rule are load-bearing. It appears only where the bar is the router's **own**
 * measurement, because these slices sum to that measurement and putting them beside a
 * provider-reported percentage would be a curve about one accounting sitting under a number from
 * another. And it is validated rather than trusted: an older router simply omits the field.
 */
describe("the measured consumption curve", () => {
  const measured = (overrides: Partial<QuotaWindowView> = {}) =>
    window({
      utilization: null,
      utilizationSource: "threshold-triggered",
      tokensUsed: 300,
      tokenLimit: 1_000,
      tokenSeries: [100, 0, 200],
      ...overrides,
    })

  test("rides along where the bar is our own count", () => {
    expect(describeQuotaWindow("active", measured(), NOW).tokenSeries).toEqual([100, 0, 200])
  })

  test("is dropped where the provider stated a percentage of its own", () => {
    // The bar is now the provider's reading; the slices describe ours. Two measurements.
    const view = describeQuotaWindow("active", measured({ utilization: 0.62 }), NOW)

    expect(view.utilization).toBe(0.62)
    expect(view.tokenSeries).toEqual([])
  })

  test("is dropped where there is no configured ceiling to measure against", () => {
    expect(describeQuotaWindow("active", measured({ tokenLimit: null }), NOW).tokenSeries).toEqual(
      [],
    )
  })

  /** An older router omits the field entirely; a chart handed `undefined` renders as broken. */
  test("an absent or malformed series is empty, never passed through", () => {
    const { tokenSeries, ...withoutSeries } = measured()
    expect(describeQuotaWindow("active", withoutSeries, NOW).tokenSeries).toEqual([])
    expect(
      describeQuotaWindow("active", measured({ tokenSeries: [1, Number.NaN] }), NOW).tokenSeries,
    ).toEqual([])
  })

  /** One slice is a dot. `Sparkline` would draw it as a flat line claiming a shape nobody measured. */
  test("a single point is not a trend", () => {
    expect(
      describeQuotaWindow("active", measured({ tokenSeries: [500] }), NOW).tokenSeries,
    ).toEqual([])
  })
})

describe("parseInstant", () => {
  // The guard every countdown consumer must share: a malformed instant is *no* instant. A bare
  // Date.parse hands NaN to formatDuration and the row renders "Invalid Date" beside "in 0s".
  test("a malformed instant is null, never NaN", () => {
    expect(parseInstant("not-an-instant")).toBeNull()
    expect(parseInstant("")).toBeNull()
  })

  test("null stays null and a real instant becomes epoch ms", () => {
    expect(parseInstant(null)).toBeNull()
    expect(parseInstant("2026-07-26T00:00:00.000Z")).toBe(Date.parse("2026-07-26T00:00:00.000Z"))
  })
})
