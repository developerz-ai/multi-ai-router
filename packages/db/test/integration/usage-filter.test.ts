import { describe, expect, test } from "bun:test"
import type { UsageFilter } from "../../src/repositories/usage-read-types"
import { usageDaily } from "../../src/schema/usage-daily"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

/**
 * The usage filter (issue #225) against real Postgres, over every source `historySource` unions:
 * the legacy `usage_daily` days, the v2 daily rollups (full days) and the receipt contributions
 * (partial-day edges). Expected values are hand-folded from the same fixture list in JS, never
 * read back from the code under test.
 */
const fixture = usageHistoryFixture()

const K = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const
const A = [crypto.randomUUID(), crypto.randomUUID()] as const // A[1] is a subscription account
const P = [crypto.randomUUID(), crypto.randomUUID()] as const

interface Fact {
  readonly at: string
  readonly key: string
  readonly account: string
  readonly pool: string | null
  readonly model: string
  readonly basis: "metered" | "notional" | "unknown"
  readonly outcome?: "success" | "upstream_error"
}
const facts: Fact[] = [
  // Full days 03-10 / 03-11 (rollup path) and the 03-09 evening edge (receipt path).
  {
    at: "1984-03-09T18:00:00Z",
    key: K[0],
    account: A[0],
    pool: P[0],
    model: "m1",
    basis: "metered",
  },
  {
    at: "1984-03-10T01:00:00Z",
    key: K[0],
    account: A[0],
    pool: P[0],
    model: "m1",
    basis: "metered",
  },
  {
    at: "1984-03-10T09:00:00Z",
    key: K[0],
    account: A[1],
    pool: P[1],
    model: "m2",
    basis: "notional",
  },
  {
    at: "1984-03-10T10:00:00Z",
    key: K[1],
    account: A[0],
    pool: null,
    model: "m1",
    basis: "unknown",
  },
  {
    at: "1984-03-10T11:00:00Z",
    key: K[1],
    account: A[1],
    pool: P[0],
    model: "m2",
    basis: "notional",
    outcome: "upstream_error",
  },
  {
    at: "1984-03-10T14:00:00Z",
    key: K[2],
    account: A[0],
    pool: P[1],
    model: "m2",
    basis: "metered",
  },
  {
    at: "1984-03-11T08:00:00Z",
    key: K[2],
    account: A[1],
    pool: null,
    model: "m1",
    basis: "unknown",
  },
  {
    at: "1984-03-11T20:00:00Z",
    key: K[0],
    account: A[1],
    pool: P[0],
    model: "m1",
    basis: "notional",
  },
]
// Legacy `usage_daily` days: attempts only, no unpriced measure, no pool-less rows.
const legacy = [
  {
    day: "1984-03-01",
    key: K[0],
    account: A[0],
    pool: P[0],
    model: "m1",
    attempts: 4,
    cost: "0.400000",
  },
  {
    day: "1984-03-02",
    key: K[2],
    account: A[1],
    pool: P[1],
    model: "m2",
    attempts: 3,
    cost: "0.300000",
  },
]

const rows = facts.map((f) => ({
  fact: f,
  attempt: historyAttempt({
    apiKeyId: f.key,
    accountId: f.account,
    poolId: f.pool,
    model: f.model,
    outcome: f.outcome ?? "success",
    costBasis: f.basis,
    costEstimate: f.basis === "unknown" ? null : f.basis === "metered" ? "0.100000" : "0.200000",
    tokensIn: 10,
    tokensOut: 5,
    createdAt: new Date(f.at),
  }),
}))

type Pick_ = (f: { key: string; account: string; pool: string | null; model: string }) => boolean
const matcher =
  (filter: UsageFilter): Pick_ =>
  (f) =>
    (filter.apiKeyIds === undefined || filter.apiKeyIds.includes(f.key)) &&
    (filter.accountIds === undefined || filter.accountIds.includes(f.account)) &&
    (filter.poolIds === undefined || (f.pool !== null && filter.poolIds.includes(f.pool))) &&
    (filter.models === undefined || filter.models.includes(f.model))

function expected(from: Date, to: Date, filter: UsageFilter) {
  const match = matcher(filter)
  const sum = {
    requests: 0,
    attempts: 0,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    costMetered: 0,
    costNotional: 0,
    unpriced: 0,
  }
  for (const { fact, attempt } of rows) {
    const at = (attempt.createdAt as Date).getTime()
    if (at < from.getTime() || at >= to.getTime() || !match(fact)) continue
    sum.requests += 1
    sum.attempts += 1
    sum.errors += fact.outcome === "upstream_error" ? 1 : 0
    sum.tokensIn += 10
    sum.tokensOut += 5
    if (fact.basis === "metered") sum.costMetered += 0.1
    if (fact.basis === "notional") sum.costNotional += 0.2
    if (fact.basis === "unknown") sum.unpriced += 1
  }
  for (const l of legacy) {
    const at = new Date(`${l.day}T00:00:00Z`).getTime()
    if (at < from.getTime() || at >= to.getTime()) continue
    if (!match({ key: l.key, account: l.account, pool: l.pool, model: l.model })) continue
    sum.requests += l.attempts
    sum.attempts += l.attempts
    sum.costMetered += Number(l.cost)
  }
  return sum
}

async function seed() {
  await fixture.setUnpricedSince("1984-01-01")
  await fixture.usage().insertBatch({
    attempts: rows.map((r) => r.attempt),
    terminals: rows.map((r) =>
      historyTerminal(r.attempt, {
        outcome: r.fact.outcome ?? "success",
        settledAt: new Date((r.attempt.createdAt as Date).getTime() + 60_000),
      }),
    ),
  })
  const sql = fixture.get().sql
  await sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
  for (const l of legacy)
    await fixture.db().insert(usageDaily).values({
      day: l.day,
      apiKeyId: l.key,
      accountId: l.account,
      poolId: l.pool,
      model: l.model,
      requests: l.attempts,
      attempts: l.attempts,
      costMetered: l.cost,
    })
  await sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
}

const wholeDays = { from: new Date("1984-03-09T12:00:00Z"), to: new Date("1984-03-12T00:00:00Z") }
const partialDay = { from: new Date("1984-03-10T06:00:00Z"), to: new Date("1984-03-10T12:00:00Z") }
const withLegacy = { from: new Date("1984-03-01T00:00:00Z"), to: new Date("1984-03-12T00:00:00Z") }

const filters: readonly [string, UsageFilter][] = [
  ["none", {}],
  ["one key", { apiKeyIds: [K[0]] }],
  ["two keys (OR)", { apiKeyIds: [K[0], K[2]] }],
  ["account", { accountIds: [A[1]] }],
  ["pool", { poolIds: [P[0]] }],
  ["model", { models: ["m2"] }],
  ["key AND model", { apiKeyIds: [K[0], K[1]], models: ["m2"] }],
  ["all dimensions", { apiKeyIds: [K[0]], accountIds: [A[1]], poolIds: [P[0]], models: ["m1"] }],
]

describe.skipIf(!historyUrl)("usage filter against every history source", () => {
  test("seed", seed)

  for (const [name, window] of [
    ["whole days + edge (rollup and receipts)", wholeDays],
    ["a partial day (receipts only)", partialDay],
    ["spanning legacy usage_daily days", withLegacy],
  ] as const) {
    for (const [label, filter] of filters) {
      test(`${name}: ${label}`, async () => {
        const want = expected(window.from, window.to, filter)
        const got = await fixture.history().totals(window, filter)
        expect(got).toMatchObject({
          requests: want.requests,
          attempts: want.attempts,
          errors: want.errors,
          tokensIn: want.tokensIn,
          tokensOut: want.tokensOut,
        })
        expect(Number(got.costMetered)).toBeCloseTo(want.costMetered, 6)
        expect(Number(got.costNotional)).toBeCloseTo(want.costNotional, 6)
        expect(got.unpriced.attempts).toBe(want.unpriced)
        // The series must agree with the totals it is drawn beside.
        const series = await fixture.history().series(window, "day", 1, filter)
        expect(series.reduce((n, p) => n + p.attempts, 0)).toBe(want.attempts)
        // And so must the raw outcomes pane (inside the retained window).
        const outcomes = await fixture.raw().outcomes(window, filter)
        const retained = expected(window.from, window.to, filter)
        const rawAttempts = outcomes.reduce((n, o) => n + o.attempts, 0)
        const legacyAttempts = legacy
          .filter(
            (l) =>
              new Date(`${l.day}T00:00:00Z`) >= window.from &&
              new Date(`${l.day}T00:00:00Z`) < window.to &&
              matcher(filter)({ key: l.key, account: l.account, pool: l.pool, model: l.model }),
          )
          .reduce((n, l) => n + l.attempts, 0)
        expect(rawAttempts).toBe(retained.attempts - legacyAttempts)
      })
    }
  }

  test("an empty id set yields zeros produced in SQL, with the right unpriced value", async () => {
    for (const filter of [
      { apiKeyIds: [] },
      { accountIds: [] },
      { poolIds: [] },
      { models: [] },
    ] satisfies UsageFilter[]) {
      const got = await fixture.history().totals(wholeDays, filter)
      expect(got).toMatchObject({ requests: 0, attempts: 0, tokensIn: 0, costMetered: "0.000000" })
      expect(got.unpriced.attempts).toBe(0)
    }
    // A window wholly before measurement stays null, not a hand-built 0.
    await fixture.setUnpricedSince("2099-01-01")
    const before = await fixture.history().totals(wholeDays, { apiKeyIds: [] })
    expect(before.unpriced.attempts).toBeNull()
    await fixture.setUnpricedSince("1984-01-01")
  })

  test("a pool filter never selects the pool-less rows", async () => {
    const got = await fixture.history().totals(wholeDays, { poolIds: [P[0], P[1]] })
    const want = expected(wholeDays.from, wholeDays.to, { poolIds: [P[0], P[1]] })
    expect(got.attempts).toBe(want.attempts)
    expect(want.attempts).toBeLessThan(expected(wholeDays.from, wholeDays.to, {}).attempts)
  })

  test("breakdown, seriesByDimension and raw breakdown/latency honour the filter", async () => {
    const filter: UsageFilter = { apiKeyIds: [K[0]] }
    const by = await fixture.history().breakdown(wholeDays, "model", 100, filter)
    expect(by.reduce((n, r) => n + r.attempts, 0)).toBe(
      expected(wholeDays.from, wholeDays.to, filter).attempts,
    )
    const dim = await fixture
      .history()
      .seriesByDimension(wholeDays, "day", "model", 1, undefined, filter)
    expect(dim.reduce((n, r) => n + r.requests, 0)).toBe(
      expected(wholeDays.from, wholeDays.to, filter).requests,
    )
    const raw = await fixture.raw().breakdown(wholeDays, "model", undefined, 100, filter)
    expect(raw.reduce((n, r) => n + r.attempts, 0)).toBe(
      expected(wholeDays.from, wholeDays.to, filter).attempts,
    )
    const none = await fixture.raw().latency(wholeDays, { apiKeyIds: [] })
    expect(none.p50Ms).toBeNull()
  })
})
