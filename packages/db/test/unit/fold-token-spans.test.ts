import { describe, expect, test } from "bun:test"
import { foldTokenSpans } from "../../src/repositories/usage-read-repository"

/**
 * Turning bucketed rows into one entry per (account, window).
 *
 * Pure, so it is tested here rather than against Postgres — the statement that produces these rows
 * has its own integration test. The property that matters is that **the total is the series**: the
 * progress bar and the sparkline beside it are rendered from these two fields, and if they were
 * computed separately they could disagree about the same window.
 */

const row = (accountId: string, window: string, slot: number | null, tokens: string | number) => ({
  account_id: accountId,
  window_kind: window,
  slot,
  tokens,
})

describe("folding bucketed token rows", () => {
  test("places each slot and reports the total as their sum", () => {
    const folded = foldTokenSpans(
      [row("a", "five_hour", 1, 100), row("a", "five_hour", 3, "250")],
      4,
    )

    expect(folded).toEqual([
      { accountId: "a", window: "five_hour", tokens: 350, series: [100, 0, 250, 0] },
    ])
  })

  /**
   * A quiet hour inside a window is a real measurement. A sparse series would let the chart draw a
   * smooth line through a pause that actually happened.
   */
  test("gaps are zeros, not absences", () => {
    const [folded] = foldTokenSpans([row("a", "five_hour", 5, 10)], 5)

    expect(folded?.series).toEqual([0, 0, 0, 0, 10])
  })

  /**
   * The left join's empty side. Dropping the row would make an idle account vanish from the answer
   * and render as "no reading" instead of the honest zero it is.
   */
  test("an account that recorded nothing is a flat zero line, not a missing row", () => {
    expect(foldTokenSpans([row("quiet", "seven_day", null, 0)], 3)).toEqual([
      { accountId: "quiet", window: "seven_day", tokens: 0, series: [0, 0, 0] },
    ])
  })

  test("each (account, window) pair folds separately", () => {
    const folded = foldTokenSpans(
      [row("a", "five_hour", 1, 10), row("a", "seven_day", 1, 20), row("b", "five_hour", 2, 30)],
      2,
    )

    expect(folded).toEqual([
      { accountId: "a", window: "five_hour", tokens: 10, series: [10, 0] },
      { accountId: "a", window: "seven_day", tokens: 20, series: [20, 0] },
      { accountId: "b", window: "five_hour", tokens: 30, series: [0, 30] },
    ])
  })

  /** `sum` is bigint-shaped and the driver hands it back as a string. */
  test("a string total is a number", () => {
    expect(foldTokenSpans([row("a", "five_hour", 1, "9007199254")], 1)[0]?.tokens).toBe(
      9_007_199_254,
    )
  })

  test("with no buckets asked for, the total still arrives and the series is empty", () => {
    expect(foldTokenSpans([row("a", "five_hour", null, 42)], 0)).toEqual([
      { accountId: "a", window: "five_hour", tokens: 42, series: [] },
    ])
  })

  /**
   * `width_bucket` answers `0` below the range and `slots + 1` above it. The join's own bounds
   * should keep those out, but if one arrives it must still count toward the total — losing tokens
   * silently would understate a window that is closer to spent than the bar admits.
   */
  test("an out-of-range slot still counts toward the total", () => {
    const [folded] = foldTokenSpans([row("a", "five_hour", 1, 100), row("a", "five_hour", 3, 5)], 2)

    expect(folded?.tokens).toBe(105)
    expect(folded?.series).toEqual([100, 0])
  })

  test("nothing in is nothing out", () => {
    expect(foldTokenSpans([], 12)).toEqual([])
  })
})
