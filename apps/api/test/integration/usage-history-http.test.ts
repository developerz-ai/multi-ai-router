import { describe, expect, test } from "bun:test"
import { createUsageRecentRepository } from "@multi-ai-router/db"
import { Hono } from "hono"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createUsageService, type UsageSummary } from "../../src/services/usage-read"

const fixture = usageHistoryFixture()

describe.skipIf(!historyUrl)("historical usage through actual HTTP and Postgres", () => {
  test("lifetime retains old and modern facts after purge/replay within a two-point chart", async () => {
    const owner = crypto.randomUUID()
    const old = historyAttempt({
      accountId: owner,
      model: "client-model",
      outcome: "quota_exhausted",
    })
    const failed = historyAttempt({
      correlationId: old.correlationId,
      accountId: crypto.randomUUID(),
      model: "client-model",
      outcome: "upstream_error",
    })
    const oldTerminal = historyTerminal(old, { outcome: "quota_exhausted", responseStatus: 429 })
    const currentAt = new Date(Date.now() - 2_000)
    const current = historyAttempt({
      accountId: crypto.randomUUID(),
      model: "client-model",
      createdAt: currentAt,
      latencyMs: 7,
    })
    const currentTerminal = historyTerminal(current, { settledAt: new Date(Date.now() - 1_000) })
    const writer = fixture.usage()
    await writer.insertBatch({
      attempts: [old, failed, current],
      terminals: [oldTerminal, currentTerminal],
    })
    await writer.deleteOlderThan(new Date("2000-01-01"), 100)
    expect(await writer.insertBatch({ attempts: [old, failed], terminals: [oldTerminal] })).toEqual(
      {
        insertedAttempts: 0,
        insertedTerminals: 0,
      },
    )
    const service = createUsageService({
      history: fixture.history(),
      recent: createUsageRecentRepository(fixture.db()),
      labels: async () => ({ keys: new Map(), accounts: new Map(), pools: new Map() }),
      now: () => new Date(),
      maxChartPoints: 2,
      breakdownMaxRows: 100,
    })
    const app = new Hono<AdminAuthEnv>()
    app.route(
      ADMIN_USAGE_BASE_PATH,
      adminUsageRoutes({ service, guard: async (_c, next) => next() }),
    )
    const response = await app.request(`${ADMIN_USAGE_BASE_PATH}?window=lifetime`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as UsageSummary
    expect(body.totals).toMatchObject({ attempts: 3, requests: 2, errors: 2 })
    expect(body.axis.length).toBeLessThanOrEqual(2)
    expect(body.series.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
    expect(body.series.reduce((sum, row) => sum + row.attempts, 0)).toBe(3)
    expect(body.coverage).toEqual({
      timeBasis: "event-time",
      historicalPrecision: "day",
      bucketWidth: expect.any(Number),
      requestsBasis: "terminal",
      legacy: false,
      incomplete: false,
      maxChartPoints: 2,
      retainedDetail: {
        from: currentAt.toISOString(),
        to: currentAt.toISOString(),
        attempts: 1,
        totalAttempts: 3,
        partial: true,
      },
      breakdown: { maxRows: 100, truncated: [] },
    })
    expect(body.byAccount.find((row) => row.id === owner)).toMatchObject({
      note: "deleted",
      totals: { requests: 1, attempts: 1 },
    })
    expect(body.byAccount.find((row) => row.id === current.accountId)).toMatchObject({
      latencyP95Ms: 7,
      totals: { requests: 1, attempts: 1 },
    })
    const custom = await app.request(
      `${ADMIN_USAGE_BASE_PATH}?from=1984-01-01T00:00:00.000Z&to=${new Date().toISOString()}`,
    )
    expect(custom.status).toBe(200)
    const range = (await custom.json()) as UsageSummary
    expect(range.axis.length).toBeLessThanOrEqual(2)
    expect(range.series.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
  })
})
