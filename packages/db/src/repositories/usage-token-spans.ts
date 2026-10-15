/**
 * Ask `tokensSince` for the *shape* of a window's consumption as well as its total.
 *
 * Optional because the total alone answers "how much of this window is gone", which is what the
 * progress bar needs. The shape answers the different question beside it — "how fast" — and a
 * window two-thirds spent in its first hour is a very different situation from one two-thirds spent
 * evenly, which a single number cannot distinguish.
 *
 * One query either way: the total is the sum of the buckets, so asking for both costs nothing over
 * asking for one. Slots are **equal divisions of `since..until`**, not clock hours, because each
 * window has its own span and a fixed bucket would give a five-hour window five points and a
 * seven-day one a hundred and sixty-eight.
 */
export interface TokenSpanShape {
  /** The end of every span. The same instant for all of them — "now", as the caller sees it. */
  readonly until: Date
  /** How many equal buckets to divide each span into. */
  readonly slots: number
}

export interface TokenSpanUsage {
  readonly accountId: string
  readonly window: string
  readonly tokens: number
  /**
   * Tokens per slot, oldest first, zero-filled. Empty when no shape was asked for.
   *
   * Zero-filled rather than sparse: a quiet hour inside a window is a real measurement and a
   * sparkline that closed the gap would draw a smooth line through a pause that actually happened.
   */
  readonly series: readonly number[]
}

/**
 * Slot rows back into one entry per (account, window): the zero-filled series, and the total as the
 * sum of it.
 *
 * The total is derived from the buckets rather than summed by a second aggregate, so the bar and
 * the sparkline beside it cannot disagree — they are literally the same numbers. A `null` slot is
 * the left join's empty side (an account that recorded nothing in its span) and contributes zero
 * without disturbing the series, which is what makes an idle account render as a flat line at zero
 * rather than dropping out of the answer.
 *
 * Exported for its own test: the SQL needs a database, this does not.
 */
export function foldTokenSpans(
  rows: readonly {
    readonly account_id: string
    readonly window_kind: string
    readonly slot: number | null
    readonly tokens: string | number
  }[],
  slots: number,
): readonly TokenSpanUsage[] {
  const width = Math.max(0, slots)
  const byPair = new Map<
    string,
    { accountId: string; window: string; series: number[]; unbucketed: number }
  >()

  for (const row of rows) {
    const key = `${row.account_id} ${row.window_kind}`
    const entry = byPair.get(key) ?? {
      accountId: row.account_id,
      window: row.window_kind,
      series: Array.from({ length: width }, () => 0),
      unbucketed: 0,
    }
    // `sum` is bigint-shaped, which the driver hands back as a string.
    const tokens = Number(row.tokens)
    // `width_bucket` numbers from 1; `null` is the empty side of the left join, and anything
    // outside 1..slots is a boundary the join's own bounds should already have excluded. Either
    // way those tokens still count toward the total — they are simply not placed on the curve.
    const index = (row.slot ?? 0) - 1
    if (index >= 0 && index < width) {
      entry.series[index] = (entry.series[index] ?? 0) + tokens
    } else {
      entry.unbucketed += tokens
    }
    byPair.set(key, entry)
  }

  return [...byPair.values()].map((entry) => ({
    accountId: entry.accountId,
    window: entry.window,
    tokens: entry.series.reduce((sum, value) => sum + value, entry.unbucketed),
    series: width > 0 ? entry.series : [],
  }))
}
