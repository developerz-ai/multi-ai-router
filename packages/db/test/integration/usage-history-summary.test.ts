import { describe, expect, test } from "bun:test"
import type {
  UsageDimension,
  UsageFilter,
  UsageKeyAttribution,
  UsageWindow,
} from "../../src/repositories/usage-read-types"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

/**
 * Differential: the one-statement `summaryAggregates` must return exactly what `totals` and the six
 * `breakdown` reads return, over full days and partial-day edges, with and without a filter, at a
 * limit that cuts groups and one that does not, with ties broken the same way.
 */
const fixture = usageHistoryFixture()
const dims: readonly UsageDimension[] = [
  "apiKeyId",
  "accountId",
  "poolId",
  "model",
  "owner",
  "tool",
]

const KEYS = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
const ACCOUNTS = [crypto.randomUUID(), crypto.randomUUID()]
const POOL = crypto.randomUUID()
// KEYS[2] is deliberately unlabelled (a key with no attribution: "#deleted"); a null key is "#none".
const attribution: UsageKeyAttribution = {
  ids: [KEYS[0] ?? "", KEYS[1] ?? ""],
  owners: ["alice", null],
  ownerKinds: ["person", null],
  tools: ["claude-code", "ci"],
}

async function seed() {
  const attempts = []
  const terminals = []
  for (let day = 2; day <= 6; day++) {
    for (let i = 0; i < 6; i++) {
      const row = historyAttempt({
        createdAt: new Date(Date.UTC(1984, 0, day, 3 + i * 3, 17)),
        apiKeyId: i === 5 ? null : (KEYS[i % 3] ?? null),
        accountId: ACCOUNTS[i % 2] ?? null,
        poolId: i % 3 === 0 ? POOL : null,
        model: i % 4 === 0 ? null : `model-${i % 3}`,
        // Equal token counts across groups on some days, so the id tiebreak is exercised.
        tokensIn: day % 2 === 0 ? 5 : i + day,
        tokensOut: 2,
        costEstimate: `0.${String(i + 1).padStart(6, "0")}`,
        costBasis: i === 4 ? "unknown" : "metered",
      })
      attempts.push(row)
      terminals.push(historyTerminal(row, { settledAt: row.createdAt ?? new Date(0) }))
    }
  }
  await fixture.usage().insertBatch({ attempts, terminals })
}

async function separately(window: UsageWindow, limit: number, filter: UsageFilter) {
  const history = fixture.history()
  const breakdowns = Object.fromEntries(
    await Promise.all(
      dims.map(async (d) => [
        d,
        d === "owner" || d === "tool"
          ? await history.breakdown(window, d, limit, filter, attribution)
          : await history.breakdown(window, d, limit, filter),
      ]),
    ),
  )
  return { totals: await history.totals(window, filter), breakdowns }
}

describe.skipIf(!historyUrl)("summaryAggregates", () => {
  test("equals totals + six breakdowns across windows, limits and filters", async () => {
    await seed()
    await fixture.setUnpricedSince("1984-01-04")
    const windows: UsageWindow[] = [
      // Whole days only.
      { from: new Date("1984-01-02T00:00:00Z"), to: new Date("1984-01-07T00:00:00Z") },
      // Partial edges on both sides: receipts carry the edges, aggregates the middle.
      { from: new Date("1984-01-02T10:00:00Z"), to: new Date("1984-01-05T07:30:00Z") },
      // Wholly before the unpriced measure starts.
      { from: new Date("1984-01-02T00:00:00Z"), to: new Date("1984-01-03T00:00:00Z") },
      // Nothing in it at all.
      { from: new Date("1985-01-01T00:00:00Z"), to: new Date("1985-01-02T00:00:00Z") },
    ]
    const filters: UsageFilter[] = [
      {},
      { accountIds: [ACCOUNTS[0] ?? ""] },
      { models: ["model-1"] },
    ]
    let compared = 0
    for (const window of windows)
      for (const filter of filters)
        for (const limit of [1, 2, 101]) {
          const together = await fixture
            .history()
            .summaryAggregates(window, limit, filter, attribution)
          expect(together).toEqual(await separately(window, limit, filter))
          compared++
        }
    expect(compared).toBe(36)
    // The fixture actually exercises the cut and the buckets.
    const full = await fixture
      .history()
      .summaryAggregates(windows[0] ?? { from: new Date(0), to: new Date(0) }, 101, {}, attribution)
    expect(full.breakdowns.apiKeyId.length).toBe(4)
    expect(full.breakdowns.owner.map((row) => row.id).sort()).toEqual(
      ["#deleted", "#none", "#unassigned", "person/alice"].sort(),
    )
    expect(full.totals.attempts).toBe(30)
  })

  test("refuses a limit outside the breakdown bounds", async () => {
    const window: UsageWindow = { from: new Date(0), to: new Date(1) }
    await expect(fixture.history().summaryAggregates(window, 0, {}, attribution)).rejects.toThrow()
  })
})
