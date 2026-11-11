import { expect, test } from "bun:test"
import type { UsageReadRepository } from "@multi-ai-router/db"
import { EMPTY_TOTALS } from "../../../src/services/usage-read/rollup"
import { readSummary } from "../../../src/services/usage-read/summary"
import {
  groupedFacts,
  perDimensionFacts,
  type SummaryFactsInput,
  type SummaryFactsReader,
} from "../../../src/services/usage-read/summary-facts"
import { historyFixture } from "./history-fixture"

/**
 * 07.7 / 10.11: the summary's totals and six breakdowns go through one injected reader, so a single
 * `GROUPING SETS` statement can replace the seven it issues today. The differential harness below is
 * what that replacement must pass: identical summaries over the same data.
 */

const now = new Date("2026-10-03T12:00:00Z")
const labels = { keys: new Map(), accounts: new Map(), pools: new Map() }

function raw(): UsageReadRepository {
  const row = (id: string | null, attempts: number) => ({
    ...EMPTY_TOTALS,
    id,
    attempts,
    requests: attempts,
    latencyP50Ms: 4,
    latencyP95Ms: 8,
    routerOverheadP95Ms: 1,
  })
  return {
    tokensSince: async () => [],
    totals: async () => ({ ...EMPTY_TOTALS, attempts: 9, requests: 7 }),
    breakdown: async (_window, dimension) =>
      dimension === "model" ? [row("sonnet", 6), row("opus", 3)] : [row("a", 5), row(null, 4)],
    series: async () => [],
    seriesByDimension: async () => [],
    latency: async () => ({ p50Ms: 4, p95Ms: 8, routerOverheadP95Ms: 1, ttfbP95Ms: null }),
    outcomes: async () => [{ outcome: "success", attempts: 9 }],
  }
}

/** Runs one summary per reader over the same fixture; the replacement must match the baseline. */
async function differential(candidate: (base: SummaryFactsReader) => SummaryFactsReader) {
  const repo = raw()
  const history = historyFixture(repo, now)
  history.totals = async () => ({ ...EMPTY_TOTALS, attempts: 9, requests: 7 })
  const read = (facts: SummaryFactsReader) =>
    readSummary({ history, raw: repo, labels, now: () => now, facts }, { window: "today" }, {})
  const base = perDimensionFacts(history)
  return { baseline: await read(base), replaced: await read(candidate(base)) }
}

test("an injected facts reader replaces the seven per-dimension statements, with identical output", async () => {
  const inputs: SummaryFactsInput[] = []
  const { baseline, replaced } = await differential((base) => async (input) => {
    inputs.push(input)
    // A single-statement reader answers the same question in one round trip.
    return base(input)
  })
  expect(replaced).toEqual(baseline)
  expect(inputs).toHaveLength(1)
  expect(inputs[0]?.dimensions).toEqual([
    "apiKeyId",
    "accountId",
    "poolId",
    "model",
    "owner",
    "tool",
  ])
  expect(inputs[0]?.limit).toBe(101)
})

test("the GROUPING SETS reader produces the identical summary, in one repository call", async () => {
  let calls = 0
  const { baseline, replaced } = await differential(() => {
    const repo = raw()
    const history = historyFixture(repo, now)
    history.totals = async () => ({ ...EMPTY_TOTALS, attempts: 9, requests: 7 })
    const aggregates = history.summaryAggregates
    history.summaryAggregates = (...args) => {
      calls += 1
      return aggregates(...args)
    }
    return groupedFacts(history)
  })
  expect(replaced).toEqual(baseline)
  expect(calls).toBe(1)
})

test("a reader that disagrees is caught by the harness", async () => {
  const { baseline, replaced } = await differential((base) => async (input) => {
    const facts = await base(input)
    return { ...facts, totals: { ...facts.totals, attempts: facts.totals.attempts + 1 } }
  })
  expect(replaced).not.toEqual(baseline)
})
