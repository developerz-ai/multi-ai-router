import { describe, expect, test } from "bun:test"
import { createUsageRecentRepository } from "@multi-ai-router/db"
import { Hono } from "hono"
import {
  historyAttempt,
  historyUrl,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createUsageService, type UsageSummary } from "../../src/services/usage-read"

/**
 * The unpriced measure through real HTTP and Postgres, once per serving path: the receipts query
 * behind `?window=today`, and `usage_attempt_daily_v2` behind a closed past day. Both need
 * `unpriced_since` moved on or before the attempt's day — the migration seeds it tomorrow.
 */

const fixture = usageHistoryFixture()
const app = () => {
  const service = createUsageService({
    exportMaxRows: 50_000,
    history: fixture.history(),
    recent: createUsageRecentRepository(fixture.db()),
    labels: async () => ({ keys: new Map(), accounts: new Map(), pools: new Map() }),
    now: () => new Date(),
  })
  const hono = new Hono<AdminAuthEnv>()
  hono.route(
    ADMIN_USAGE_BASE_PATH,
    adminUsageRoutes({ service, guard: async (_c, next) => next() }),
  )
  return hono
}
/**
 * Midway between today's UTC midnight and now: never yesterday (a `now - 2s` stamp is, just after
 * midnight) and never in the future, which the `today` window would not include.
 */
const insideToday = () => {
  const midnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime()
  return new Date((midnight + Date.now()) / 2)
}
const setSince = (day: string) => fixture.setUnpricedSince(day)

describe.skipIf(!historyUrl)("unpriced attempts through actual HTTP and Postgres", () => {
  test("today's attempt is counted by the receipts query alone", async () => {
    await setSince(new Date().toISOString().slice(0, 10))
    const model = `unpriced-${crypto.randomUUID()}`
    await fixture.usage().insertBatch({
      attempts: [
        historyAttempt({
          model,
          costBasis: "unknown",
          costEstimate: null,
          tokensIn: 25,
          tokensOut: 5,
          createdAt: insideToday(),
        }),
      ],
      terminals: [],
    })
    const response = await app().request(`${ADMIN_USAGE_BASE_PATH}?window=today`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as UsageSummary
    expect(body.totals.unpriced.attempts).toBe(1)
    expect(body.byModel.find((row) => row.id === model)?.totals.unpriced.attempts).toBe(1)
  })

  test("a closed past day on or after since is counted from usage_attempt_daily_v2", async () => {
    const day = new Date(Date.now() - 3 * 86400000)
    const dayText = day.toISOString().slice(0, 10)
    await setSince(dayText)
    const model = `unpriced-${crypto.randomUUID()}`
    await fixture.usage().insertBatch({
      attempts: [
        historyAttempt({
          model,
          costBasis: "unknown",
          costEstimate: null,
          tokensIn: 25,
          tokensOut: 5,
          createdAt: new Date(`${dayText}T12:00:00Z`),
        }),
      ],
      terminals: [],
    })
    const response = await app().request(
      `${ADMIN_USAGE_BASE_PATH}?from=${dayText}T00:00:00.000Z&to=${new Date(day.getTime() + 86400000).toISOString().slice(0, 10)}T00:00:00.000Z`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as UsageSummary
    expect(body.totals.unpriced).toEqual({ attempts: 1, since: dayText })
    expect(body.byModel.find((row) => row.id === model)?.totals.unpriced.attempts).toBe(1)
  })
})
