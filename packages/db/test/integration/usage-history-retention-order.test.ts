import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { usageContributions } from "../../src/schema/usage-contributions"
import { historyUrl, usageHistoryFixture } from "./usage-history-fixture"

/**
 * History retention drains receipts in bounded batches ordered by `day` alone (a second key made
 * every batch sort the whole expired backlog). The order inside a day is irrelevant; the order
 * across days is not: the oldest day must go first, and the total must not change.
 */
const fixture = usageHistoryFixture()

describe.skipIf(!historyUrl)("history receipt retention order", () => {
  test("drains oldest day first, in bounded batches, keeping the horizon day", async () => {
    const days = ["1990-01-01", "1990-01-02", "1990-01-03"]
    await fixture
      .db()
      .insert(usageContributions)
      .values(
        days.flatMap((day) =>
          Array.from({ length: 3 }, () => ({
            id: crypto.randomUUID(),
            kind: "attempt" as const,
            day,
            source: "live" as const,
            payloadHash: "h",
            payload: {} as never,
          })),
        ),
      )
    const remainingDays = async () =>
      (
        await fixture
          .db()
          .select({ day: usageContributions.day, n: sql<number>`count(*)::int` })
          .from(usageContributions)
          .groupBy(usageContributions.day)
          .orderBy(usageContributions.day)
      ).map((row) => [row.day, row.n])

    const cutoff = new Date("1990-01-03T00:00:00Z")
    const history = fixture.history()
    expect(await history.deleteOlderThan(cutoff, 2)).toBe(2)
    expect(await remainingDays()).toEqual([
      ["1990-01-01", 1],
      ["1990-01-02", 3],
      ["1990-01-03", 3],
    ])
    expect(await history.deleteOlderThan(cutoff, 2)).toBe(2)
    expect(await remainingDays()).toEqual([
      ["1990-01-02", 2],
      ["1990-01-03", 3],
    ])
    expect(await history.deleteOlderThan(cutoff, 5)).toBe(2)
    expect(await history.deleteOlderThan(cutoff, 5)).toBe(0)
    expect(await remainingDays()).toEqual([["1990-01-03", 3]])
  })
})
