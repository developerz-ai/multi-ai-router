import { expect, test } from "bun:test"
import type { UsageReadRepository } from "@multi-ai-router/db"
import { EMPTY_TOTALS } from "../../../src/services/usage-read/rollup"
import { readSummary } from "../../../src/services/usage-read/summary"
import { historyFixture } from "./history-fixture"

const now = new Date("2026-10-03T12:00:00Z")
const earliestAt = new Date("2025-01-01T00:00:00Z")

test("lifetime retains modern history, exact historical counts and explicit raw-detail coverage", async () => {
  const raw: UsageReadRepository = {
    totals: async () => {
      throw new Error("history totals must not scan raw")
    },
    breakdown: async (_window, _dimension, ids) => {
      expect(ids).toEqual(["gone"])
      return [
        {
          ...EMPTY_TOTALS,
          id: "gone",
          attempts: 2,
          requests: 2,
          latencyP50Ms: 5,
          latencyP95Ms: 9,
          routerOverheadP95Ms: 1,
        },
      ]
    },
    series: async () => {
      throw new Error("history chart must not scan raw")
    },
    seriesByDimension: async () => {
      throw new Error("history group chart must not scan raw")
    },
    latency: async () => ({ p50Ms: 5, p95Ms: 9, routerOverheadP95Ms: 1, ttfbP95Ms: 2 }),
    outcomes: async () => [{ outcome: "upstream_error", attempts: 2 }],
  }
  const history = historyFixture(raw, now, {
    earliestAt,
    rawFrom: new Date("2026-10-01T00:00:00Z"),
    rawTo: now,
    legacy: true,
    requestsBasis: "mixed-legacy",
    incomplete: true,
  })
  history.totals = async () => ({ ...EMPTY_TOTALS, attempts: 20, requests: 10 })
  history.breakdown = async () =>
    ["gone", null].map((id) => ({
      ...EMPTY_TOTALS,
      id,
      attempts: 10,
      requests: 5,
      latencyP50Ms: null,
      latencyP95Ms: null,
      routerOverheadP95Ms: null,
    }))
  const widths: number[] = []
  history.series = async (_window, _bucket, width) => {
    widths.push(width ?? 1)
    const step = (width ?? 1) * 86400000
    return [
      {
        at: new Date(Math.floor(now.getTime() / step) * step).toISOString().replace(".000Z", "Z"),
        requests: 10,
        attempts: 20,
        errors: 2,
      },
    ]
  }
  history.seriesByDimension = async () => []
  const summary = await readSummary(
    {
      history,
      raw,
      labels: { keys: new Map(), accounts: new Map(), pools: new Map() },
      now: () => now,
      maxChartPoints: 12,
      breakdownMaxRows: 1,
    },
    { window: "lifetime" },
  )
  expect(summary.from).toBe(earliestAt.toISOString())
  expect(summary.axis.length).toBeLessThanOrEqual(12)
  expect(summary.series.at(-1)?.requests).toBe(10)
  expect(summary.coverage.bucketWidth).toBe(widths[0])
  expect(summary.totals.attempts).toBe(20)
  expect(summary.failures).toMatchObject({ attempts: 2, errors: 2, partial: true })
  expect(summary.coverage.retainedDetail).toMatchObject({
    attempts: 2,
    totalAttempts: 20,
    partial: true,
  })
  expect(summary.coverage.legacy).toBe(true)
  expect(summary.coverage.breakdown.truncated).toEqual(["apiKeyId", "accountId", "poolId", "model"])
  expect(summary.byAccount).toHaveLength(1)
  expect(summary.byAccount[0]).toMatchObject({
    id: "gone",
    note: "deleted",
    latencyP95Ms: 9,
    totals: { attempts: 10, requests: 5 },
  })
  expect(summary.latency.p95Ms).toBe(9)
})

test("the maximum group setting queries a sentinel and only charts selected groups", async () => {
  const raw: UsageReadRepository = {
    totals: async () => EMPTY_TOTALS,
    breakdown: async () => [],
    series: async () => [],
    seriesByDimension: async () => [],
    outcomes: async () => [],
    latency: async () => ({ p50Ms: null, p95Ms: null, routerOverheadP95Ms: null, ttfbP95Ms: null }),
  }
  const history = historyFixture(raw, now)
  const limits: number[] = []
  const selected: number[] = []
  history.breakdown = async (_window, _dimension, limit) => {
    limits.push(limit ?? 0)
    return Array.from({ length: limit ?? 0 }, (_, i) => ({
      ...EMPTY_TOTALS,
      id: `group-${i}`,
      latencyP50Ms: null,
      latencyP95Ms: null,
      routerOverheadP95Ms: null,
    }))
  }
  history.seriesByDimension = async (_window, _bucket, _dimension, _width, ids) => {
    selected.push(ids?.length ?? -1)
    return []
  }
  const summary = await readSummary(
    {
      history,
      raw,
      labels: { keys: new Map(), accounts: new Map(), pools: new Map() },
      now: () => now,
      breakdownMaxRows: 1000,
    },
    { window: "today" },
  )
  expect(limits).toEqual([1001, 1001, 1001, 1001])
  expect(selected).toEqual([1000, 1000, 1000, 1000])
  expect(summary.byKey).toHaveLength(1000)
  expect(summary.coverage.breakdown.truncated).toEqual(["apiKeyId", "accountId", "poolId", "model"])
})

test("pending legacy detail keeps its numerator while disclosing the unfinished historical denominator", async () => {
  const raw: UsageReadRepository = {
    totals: async () => EMPTY_TOTALS,
    breakdown: async () => [],
    series: async () => [],
    seriesByDimension: async () => [],
    outcomes: async () => [{ outcome: "upstream_error", attempts: 1 }],
    latency: async () => ({ p50Ms: 5, p95Ms: 5, routerOverheadP95Ms: 1, ttfbP95Ms: null }),
  }
  const history = historyFixture(raw, now, { incomplete: true, requestsBasis: "mixed-legacy" })
  const summary = await readSummary(
    {
      history,
      raw,
      now: () => now,
      labels: { keys: new Map(), accounts: new Map(), pools: new Map() },
    },
    { window: "today" },
  )
  expect(summary.totals.attempts).toBe(0)
  expect(summary.failures).toMatchObject({ attempts: 1, errors: 1, partial: true })
  expect(summary.coverage.incomplete).toBe(true)
  expect(summary.coverage.retainedDetail).toMatchObject({
    attempts: 1,
    totalAttempts: 0,
    partial: true,
  })
  expect(summary.latency.p95Ms).toBe(5)
})
