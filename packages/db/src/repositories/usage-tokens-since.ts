import { sql } from "drizzle-orm"
import type { Database } from "../client"
import { usageRecords } from "../schema/usage-records"
import type { UsageReadRepository } from "./usage-read-types"
import { foldTokenSpans } from "./usage-token-spans"

export function createTokensSince(db: Database): UsageReadRepository["tokensSince"] {
  /**
   * One statement over a VALUES list of (account, window, since), so a fleet of subscriptions
   * costs one round trip rather than one per window per account.
   */
  return async (spans, shape) => {
    if (spans.length === 0) return []

    // `width_bucket` refuses a range whose bounds are equal, and a span that has not opened yet has
    // nothing to measure anyway. Dropped rather than clamped: a zero-width window is a caller bug,
    // and silently widening it would report tokens against a range nobody asked about.
    const usable =
      shape === undefined
        ? spans
        : spans.filter((span) => span.since.getTime() < shape.until.getTime())
    if (usable.length === 0) return []

    const values = sql.join(
      usable.map(
        (span) =>
          sql`(${span.accountId}::uuid, ${span.window}::text, ${span.since.toISOString()}::timestamptz)`,
      ),
      sql`, `,
    )

    const tokenSum = sql`coalesce(sum(
      ${usageRecords.tokensIn} + ${usageRecords.tokensOut}
      + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens}
    ), 0)`

    // Equal divisions of each span's own `since..until`, so every window yields the same number of
    // points whatever its length. `width_bucket` answers 1..slots inside the range; the join's own
    // bounds keep anything outside it out, and a `null` here is the left join's empty side.
    //
    // `width_bucket` refuses a non-positive bucket count as hard as it refuses equal bounds, and
    // `slots` crosses as a bare parameter no column encoder types (hence the `::int`). A shape with
    // no positive width keeps its bounds — they still name each span's measured range — but draws
    // no curve, the same answer `foldTokenSpans` gives an empty width: a caller bug degrades to
    // "no sparkline", never a server error on the whole statement.
    const bucketed = shape !== undefined && shape.slots > 0
    const slot = bucketed
      ? sql`width_bucket(
          extract(epoch from ${usageRecords.createdAt}),
          extract(epoch from s.since),
          extract(epoch from ${shape.until.toISOString()}::timestamptz),
          ${shape.slots}::int
        )`
      : sql`null::int`

    const upperBound =
      shape === undefined
        ? sql``
        : sql`and ${usageRecords.createdAt} < ${shape.until.toISOString()}::timestamptz`

    // `window_kind`, never `window`: WINDOW is a reserved keyword in Postgres (it introduces a
    // window-function clause), so an alias column named `window` makes the whole statement a
    // syntax error. Renaming is clearer than quoting — nobody has to remember the quotes later.
    const rows = await db.execute<{
      account_id: string
      window_kind: string
      slot: number | null
      tokens: string | number
    }>(
      sql`
        select s.account_id, s.window_kind, ${slot} as slot, ${tokenSum} as tokens
        from (values ${values}) as s(account_id, window_kind, since)
        left join ${usageRecords}
          on ${usageRecords.accountId} = s.account_id
         and ${usageRecords.createdAt} >= s.since
         ${upperBound}
        group by s.account_id, s.window_kind, slot
      `,
    )

    return foldTokenSpans([...rows], bucketed ? shape.slots : 0)
  }
}
