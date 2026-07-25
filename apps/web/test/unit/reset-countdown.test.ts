import { describe, expect, test } from "bun:test"
import { ResetSource } from "@multi-ai-router/core"
import {
  describeInstant,
  describeReset,
  formatDuration,
  NEEDS_TOPUP,
  type ResetInput,
  resetQualifier,
} from "../../src/lib/reset-countdown"

// A fixed clock, passed in. Nothing in this module reads Date.now().
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("formatDuration", () => {
  test("collapses to two units at most, coarsest first", () => {
    expect(formatDuration(2 * DAY + 3 * HOUR + 40 * MINUTE)).toBe("2d 3h")
    expect(formatDuration(HOUR + 12 * MINUTE + 30 * SECOND)).toBe("1h 12m")
    expect(formatDuration(4 * MINUTE + 30 * SECOND)).toBe("4m 30s")
    expect(formatDuration(45 * SECOND)).toBe("45s")
  })

  test("drops a zero unit rather than printing it", () => {
    expect(formatDuration(2 * DAY)).toBe("2d")
    expect(formatDuration(3 * HOUR)).toBe("3h")
    expect(formatDuration(5 * MINUTE)).toBe("5m")
  })

  test("never counts backwards", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(-5 * MINUTE)).toBe("0s")
    expect(formatDuration(Number.NaN)).toBe("0s")
  })
})

// Regression gate. Web once compared against locally invented spellings
// (`"provider"` / `"estimate"`), so an API payload carrying core's real values
// fell through to the fallback branch and every provider-reported reset was
// labeled a guess. Driving the cases straight off `ResetSource.options` means a
// rename in core fails here rather than silently mislabeling in the UI.
describe("ResetSource agreement with core", () => {
  test("every source core defines produces a display", () => {
    for (const source of ResetSource.options) {
      const display = describeReset(
        { status: "cooling_down", resetsAt: NOW + HOUR, resetSource: source },
        NOW,
      )
      expect(display.text.length).toBeGreaterThan(0)
    }
  })

  test("only 'unknown' suppresses the qualifier — the rest are labeled", () => {
    const labeled = ResetSource.options.filter((source) => {
      const display = describeReset(
        { status: "cooling_down", resetsAt: NOW + HOUR, resetSource: source },
        NOW,
      )
      return display.qualifier !== null
    })
    expect(labeled.sort()).toEqual(["estimated", "provider-reported"])
  })

  test("a provider-reported source is never labeled an estimate", () => {
    const display = describeReset(
      { status: "cooling_down", resetsAt: NOW + HOUR, resetSource: "provider-reported" },
      NOW,
    )
    expect(display.qualifier).toBe("reported")
    expect(display.qualifier).not.toBe("estimated")
  })
})

// The label a per-window row uses. `describeReset` drops the qualifier for `unknown` because there
// is no instant to qualify; a table of five windows cannot, or the unlabelled row reads as the
// certain one.
describe("resetQualifier", () => {
  test("labels every source core defines, unknown included", () => {
    const labels = ResetSource.options.map((source) => resetQualifier(source))
    expect(labels.sort()).toEqual(["estimated", "reported", "unknown"])
  })
})

// The half of `describeReset` that does not consult a status. Per-window rows call it directly: a
// quota window refills on its own clock whether or not the account is currently blocked.
describe("describeInstant", () => {
  test("counts down to an instant without asking what the account's status is", () => {
    const display = describeInstant(NOW + HOUR, "provider-reported", NOW)

    expect(display.kind).toBe("countdown")
    expect(display.countdown).toBe("1h")
    expect(display.qualifier).toBe("reported")
  })

  test("reads a passed instant as due rather than counting backwards", () => {
    expect(describeInstant(NOW - HOUR, "estimated", NOW).kind).toBe("due")
  })

  test("says unknown rather than dressing an absent instant up as a fact", () => {
    expect(describeInstant(null, "provider-reported", NOW).kind).toBe("unknown")
    expect(describeInstant(NOW + HOUR, "unknown", NOW).qualifier).toBeNull()
  })
})

describe("NEEDS_TOPUP", () => {
  test("carries no countdown, so no caller can render one from it", () => {
    expect(NEEDS_TOPUP.countdown).toBeNull()
    expect(NEEDS_TOPUP.kind).toBe("needs_topup")
  })

  test("is what an exhausted account gets, whatever instant it was handed", () => {
    const display = describeReset(
      { status: "exhausted", resetsAt: NOW + HOUR, resetSource: "provider-reported" },
      NOW,
    )
    expect(display).toEqual(NEEDS_TOPUP)
  })
})

describe("describeReset", () => {
  const coolingDown = (over: Partial<ResetInput> = {}): ResetInput => ({
    status: "cooling_down",
    resetsAt: NOW + HOUR + 12 * MINUTE,
    resetSource: "provider-reported",
    ...over,
  })

  test("a provider-reported reset counts down and is marked reported", () => {
    const display = describeReset(coolingDown(), NOW)
    expect(display.kind).toBe("countdown")
    expect(display.countdown).toBe("1h 12m")
    expect(display.text).toBe("in 1h 12m")
    expect(display.qualifier).toBe("reported")
  })

  test("an estimated reset counts down but is never presented as fact", () => {
    const display = describeReset(coolingDown({ resetSource: "estimated" }), NOW)
    expect(display.kind).toBe("countdown")
    expect(display.qualifier).toBe("estimated")
  })

  // A guessed reset shown as fact is worse than no reset at all.
  test("an unknown source gets no countdown", () => {
    const display = describeReset(coolingDown({ resetSource: "unknown" }), NOW)
    expect(display.kind).toBe("unknown")
    expect(display.countdown).toBeNull()
    expect(display.qualifier).toBeNull()
    expect(display.text).toContain("backoff")
  })

  test("a missing timestamp is treated as unknown, not as zero", () => {
    const display = describeReset(coolingDown({ resetsAt: null }), NOW)
    expect(display.kind).toBe("unknown")
    expect(display.countdown).toBeNull()
  })

  test("a reset already in the past reads as due, not as a negative countdown", () => {
    const display = describeReset(coolingDown({ resetsAt: NOW - MINUTE }), NOW)
    expect(display.kind).toBe("due")
    expect(display.countdown).toBeNull()
  })

  // Inventing an ETA for a condition only a human can fix is a bug.
  test("exhausted never gets a countdown, even with a timestamp present", () => {
    const display = describeReset(
      { status: "exhausted", resetsAt: NOW + HOUR, resetSource: "provider-reported" },
      NOW,
    )
    expect(display.kind).toBe("needs_topup")
    expect(display.countdown).toBeNull()
    expect(display.text).toContain("top-up")
  })

  test("statuses with no reset render an em dash rather than a guess", () => {
    for (const status of ["active", "disabled", "needs_reauth"] as const) {
      const display = describeReset(
        { status, resetsAt: NOW + HOUR, resetSource: "provider-reported" },
        NOW,
      )
      expect(display.kind).toBe("none")
      expect(display.countdown).toBeNull()
    }
  })
})
