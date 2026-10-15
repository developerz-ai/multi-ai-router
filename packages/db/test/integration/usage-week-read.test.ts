import { describe, expect, test } from "bun:test"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

/**
 * The named week read behind the weekly report: one UTC Monday-to-Monday window at key x account x
 * pool x model, without the day dimension, over the same three-source union as the summary.
 */
const fixture = usageHistoryFixture()
const KEY = crypto.randomUUID()
const ACCOUNT_A = crypto.randomUUID()
const ACCOUNT_B = crypto.randomUUID()
const POOL = crypto.randomUUID()
const WEEK = {
  from: new Date("2026-10-05T00:00:00.000Z"),
  to: new Date("2026-10-12T00:00:00.000Z"),
}

async function seed(at: string, account: string, over: Parameters<typeof historyAttempt>[0] = {}) {
  const attempt = historyAttempt({
    apiKeyId: KEY,
    accountId: account,
    poolId: POOL,
    model: "m",
    createdAt: new Date(at),
    ...over,
  })
  await fixture.usage().insertBatch({
    attempts: [attempt],
    terminals: [historyTerminal(attempt, { settledAt: new Date(`${at.slice(0, 19)}.500Z`) })],
  })
}

describe.skipIf(!historyUrl)("the week read", () => {
  test("seed: two days of one grain, one unknown-basis attempt, and one on each side of the week", async () => {
    await seed("2026-10-05T12:00:00.000Z", ACCOUNT_A)
    await seed("2026-10-07T12:00:00.000Z", ACCOUNT_A)
    await seed("2026-10-11T23:59:59.000Z", ACCOUNT_B, {
      costBasis: "unknown",
      costEstimate: null,
      tokensIn: 5,
      tokensOut: 5,
    })
    // Outside: the last second of the previous week and the first instant of the next.
    await seed("2026-10-04T23:59:59.000Z", ACCOUNT_A)
    await seed("2026-10-12T00:00:00.000Z", ACCOUNT_A)
    await fixture.setUnpricedSince("2026-10-01")
  })

  test("folds days into one row per key, account, pool and model, and clips to the week", async () => {
    const { rows } = await fixture.history().weekRows(WEEK)
    expect(rows).toHaveLength(2)
    const a = rows.find((r) => r.accountId === ACCOUNT_A)
    const b = rows.find((r) => r.accountId === ACCOUNT_B)
    expect(a).toMatchObject({
      apiKeyId: KEY,
      poolId: POOL,
      model: "m",
      requests: 2,
      attempts: 2,
      tokensIn: 6,
      tokensOut: 4,
      costMetered: "0.200000",
      costNotional: "0.000000",
      unpricedAttempts: 0,
    })
    expect(b).toMatchObject({
      requests: 1,
      attempts: 1,
      tokensIn: 5,
      tokensOut: 5,
      unpricedAttempts: 1,
    })
  })

  test("a measured week reads 0 for a group with nothing unpriced, never null", async () => {
    const { rows, unpricedSince } = await fixture.history().weekRows(WEEK)
    expect(unpricedSince).toBe("2026-10-01")
    expect(rows.every((r) => typeof r.unpricedAttempts === "number")).toBe(true)
  })

  test("a week wholly before the measure started reads unmeasured (null), carrying since", async () => {
    await fixture.setUnpricedSince("2026-10-20")
    const { rows, unpricedSince } = await fixture.history().weekRows(WEEK)
    expect(unpricedSince).toBe("2026-10-20")
    expect(rows.every((r) => r.unpricedAttempts === null)).toBe(true)
  })

  test("sums equal the summary totals for the same window", async () => {
    const history = fixture.history()
    const totals = await history.totals(WEEK, {})
    const { rows } = await history.weekRows(WEEK)
    expect(rows.reduce((n, r) => n + r.requests, 0)).toBe(totals.requests)
    expect(rows.reduce((n, r) => n + r.attempts, 0)).toBe(totals.attempts)
    expect(rows.reduce((n, r) => n + r.tokensIn, 0)).toBe(totals.tokensIn)
  })
})
