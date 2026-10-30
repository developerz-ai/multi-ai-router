import { describe, expect, test } from "bun:test"
import { AdminAuthError } from "@multi-ai-router/core"
import { createUsageRecentRepository, createUsageReportRepository } from "@multi-ai-router/db"
import { Hono } from "hono"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createUsageService } from "../../src/services/usage-read"
import type { WeeklyReport } from "../../src/services/usage-report"
import { createUsageReportService } from "../../src/services/usage-report"

/**
 * The weekly report end to end: real Postgres rollups, the real builder, the real repository and
 * the real routes. The numeric fixture is the issue's: one service key scoped to two pools (P1
 * with an overflow account, P2 without), 6 attempts on members and 2 on the overflow account in
 * P1, 5 in P2, plus one null-pool preflight failure. Expect 2 of 8 = 25% for (K, P1), no P2 line.
 */
const fixture = usageHistoryFixture()
const NOW = new Date("2026-10-14T12:00:00.000Z")
const WEEK_START = "2026-10-05"

const K = crypto.randomUUID()
const PERSON = crypto.randomUUID()
const A = crypto.randomUUID()
const O = crypto.randomUUID()
const P1 = crypto.randomUUID()
const P2 = crypto.randomUUID()
const EMAIL_LABEL = "someone@example.com"

let app: Hono<AdminAuthEnv>
let service: ReturnType<typeof createUsageReportService>
let reports: ReturnType<typeof createUsageReportRepository>
// Module-scoped so the over-cap route test can mount a second app with a tight reports service.
let usage: ReturnType<typeof createUsageService>

async function seedAttempt(over: Parameters<typeof historyAttempt>[0], minute: number) {
  const attempt = historyAttempt({
    apiKeyId: K,
    model: "m1",
    createdAt: new Date(Date.parse("2026-10-06T10:00:00Z") + minute * 60_000),
    ...over,
  })
  await fixture.usage().insertBatch({
    attempts: [attempt],
    terminals: [
      historyTerminal(attempt, {
        settledAt: new Date((attempt.createdAt as Date).getTime() + 1_000),
        outcome: attempt.outcome ?? "success",
      }),
    ],
  })
}

const count = async () => {
  const rows = await fixture.get().sql.unsafe("select count(*)::int as n from usage_reports")
  return Number(rows[0]?.n ?? -1)
}

const csrfGuard = adminAuth(
  {
    authenticate: async () => ({
      id: "s",
      username: "admin",
      csrfToken: "csrf",
      createdAtMs: NOW.getTime(),
      lastSeenAtMs: NOW.getTime(),
    }),
    assertCsrf: (_session, token) => {
      if (token !== "csrf") throw new AdminAuthError("CSRF token invalid")
    },
  },
  true,
)

describe.skipIf(!historyUrl)("weekly usage reports over HTTP and Postgres", () => {
  test("seed the numeric overflow fixture", async () => {
    await fixture.setUnpricedSince("2026-09-01")
    let minute = 0
    for (let i = 0; i < 6; i++) await seedAttempt({ accountId: A, poolId: P1 }, minute++)
    for (let i = 0; i < 2; i++) await seedAttempt({ accountId: O, poolId: P1 }, minute++)
    for (let i = 0; i < 5; i++) await seedAttempt({ accountId: A, poolId: P2 }, minute++)
    await seedAttempt({ accountId: null, poolId: null, outcome: "scope_violation" }, minute++)
    // A person key on the overflow account: counted in the totals, never an overflow line.
    await seedAttempt({ apiKeyId: PERSON, accountId: O, poolId: P1 }, minute++)

    const db = fixture.db()
    reports = createUsageReportRepository(db)
    const labels = async () => ({
      keys: new Map([
        [
          K,
          {
            name: "svc-bot",
            owner: "svc",
            ownerKind: "service" as const,
            tool: "ci",
            retired: false,
            prefix: "mar_k",
          },
        ],
        [
          PERSON,
          {
            name: "ann-cli",
            owner: "ann",
            ownerKind: "person" as const,
            tool: "cli",
            retired: false,
            prefix: "mar_p",
          },
        ],
      ]),
      accounts: new Map([
        [A, EMAIL_LABEL],
        [O, "overflow@example.com"],
      ]),
      pools: new Map([
        [P1, "main"],
        [P2, "side"],
      ]),
    })
    service = createUsageReportService({
      reports,
      history: fixture.history(),
      labels,
      pools: async () => [
        { id: P1, name: "main", overflowAccountId: O, overflowProvider: "openai-oauth" },
        { id: P2, name: "side", overflowAccountId: null, overflowProvider: null },
      ],
      maxRows: 1000,
      upstreamTimeoutMs: 600_000,
      upstreamStreamTimeoutMs: 600_000,
      listLimit: 110,
      now: () => NOW,
    })
    usage = createUsageService({
      history: fixture.history(),
      recent: createUsageRecentRepository(db),
      labels,
      now: () => NOW,
      exportMaxRows: 1000,
    })
    app = new Hono<AdminAuthEnv>()
    const logger = createLogger({ level: "error", write: () => {} })
    app.onError(errorHandler(logger))
    app.notFound(notFoundHandler())
    app.route(
      ADMIN_USAGE_BASE_PATH,
      adminUsageRoutes({ service: usage, reports: service, guard: csrfGuard }),
    )
  })

  const get = (path: string) => app.request(`${ADMIN_USAGE_BASE_PATH}${path}`)
  const post = (path: string, csrf = true) =>
    app.request(`${ADMIN_USAGE_BASE_PATH}${path}`, {
      method: "POST",
      headers: csrf ? { "x-csrf-token": "csrf" } : {},
    })

  test("the list is empty before anything is generated", async () => {
    const response = await get("/reports")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reports: [] })
  })

  test("preview builds the last complete week and stores nothing", async () => {
    const before = await count()
    const response = await post("/reports/preview")
    expect(response.status).toBe(200)
    const report = (await response.json()) as WeeklyReport
    expect(report.period).toEqual({ start: WEEK_START, end: "2026-10-12" })
    expect(report.totals.requests).toBe(15)
    expect(await count()).toBe(before)
    expect(await count()).toBe(0)
  })

  test("preview is a mutating route: the guard demands a CSRF token", async () => {
    const response = await post("/reports/preview", false)
    expect([401, 403]).toContain(response.status)
    expect(await count()).toBe(0)
  })

  test("two generations that bypass the lock leave one row, and one reports the write", async () => {
    const week = { start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-12T00:00:00Z") }
    const results = await Promise.all([service.generate(week, NOW), service.generate(week, NOW)])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await count()).toBe(1)
  })

  test("the list shows the stored week, pending, without its payload", async () => {
    const body = (await (await get("/reports")).json()) as { reports: Record<string, unknown>[] }
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0]).toMatchObject({
      periodStart: WEEK_START,
      periodEnd: "2026-10-12",
      deliveryStatus: "pending",
      deliveryAttempts: 0,
      deliveredAt: null,
    })
    expect(Object.keys(body.reports[0] ?? {})).not.toContain("payload")
  })

  test("the stored report shows 2/8 = 25% for (K, P1), no P2 line, null pool in no ratio", async () => {
    const response = await get(`/reports/${WEEK_START}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { report: WeeklyReport }
    expect(body.report.overflow).toEqual([
      {
        keyName: "svc-bot",
        owner: "svc",
        ownerKind: "service",
        tool: "ci",
        poolName: "main",
        provider: "openai-oauth",
        overflowAttempts: 2,
        attempts: 8,
        share: 0.25,
      },
    ])
  })

  test("sections and buckets sum to the totals, and the totals equal the summary for the same week", async () => {
    const body = (await (await get(`/reports/${WEEK_START}`)).json()) as { report: WeeklyReport }
    const { totals, sections, buckets } = body.report
    const parts = [sections.people, sections.services, sections.unknownKind].map((s) => s.totals)
    const requests = [...parts, buckets.unassigned, buckets.deleted, buckets.none].reduce(
      (n, p) => n + p.requests,
      0,
    )
    expect(requests).toBe(totals.requests)
    const summary = await fixture
      .history()
      .totals({ from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-12T00:00:00Z") }, {})
    expect(totals.requests).toBe(summary.requests)
    expect(totals.tokensIn).toBe(summary.tokensIn)
    expect(sections.services.lines[0]).toMatchObject({ owner: "svc", tool: "ci", requests: 14 })
    expect(sections.people.lines[0]).toMatchObject({ owner: "ann", tool: "cli", requests: 1 })
  })

  test("no account label, id or email appears in the stored payload", async () => {
    const row = await reports.findByPeriodStart(WEEK_START)
    const text = JSON.stringify(row?.payload)
    for (const secret of [EMAIL_LABEL, "overflow@example.com", A, O])
      expect(text).not.toContain(secret)
  })

  test("a malformed or non-Monday period is a 400; an absent Monday is a 404", async () => {
    for (const bad of ["2026-10-06", "2026-1-5", "nope", "2026-02-30"])
      expect((await get(`/reports/${bad}`)).status).toBe(400)
    expect((await get("/reports/2026-09-28")).status).toBe(404)
  })

  test("a week over the row ceiling fails loudly naming the cap, never a truncated report", async () => {
    const tight = createUsageReportService({
      reports,
      history: fixture.history(),
      labels: async () => ({ keys: new Map() }),
      pools: async () => [],
      upstreamTimeoutMs: 600_000,
      upstreamStreamTimeoutMs: 600_000,
      listLimit: 10,
      maxRows: 1,
      now: () => NOW,
    })
    const preview = await tight.preview()
    expect(preview.ok).toBe(false)
    if (!preview.ok) {
      expect(preview.failure.status).toBe(400)
      expect(preview.failure.message).toContain("USAGE_REPORT_MAX_ROWS")
    }
    const week = { start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-12T00:00:00Z") }
    await expect(tight.generate(week, NOW)).rejects.toThrow("USAGE_REPORT_MAX_ROWS")
  })

  test("over the cap the preview route answers 400 report_too_large and stores nothing", async () => {
    const tight = createUsageReportService({
      reports,
      history: fixture.history(),
      labels: async () => ({ keys: new Map() }),
      pools: async () => [],
      upstreamTimeoutMs: 600_000,
      upstreamStreamTimeoutMs: 600_000,
      listLimit: 10,
      maxRows: 1,
      now: () => NOW,
    })
    const tightApp = new Hono<AdminAuthEnv>()
    tightApp.onError(errorHandler(createLogger({ level: "error", write: () => {} })))
    tightApp.notFound(notFoundHandler())
    tightApp.route(
      ADMIN_USAGE_BASE_PATH,
      adminUsageRoutes({ service: usage, reports: tight, guard: csrfGuard }),
    )
    const before = await count()
    const response = await tightApp.request(`${ADMIN_USAGE_BASE_PATH}/reports/preview`, {
      method: "POST",
      headers: { "x-csrf-token": "csrf" },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { readonly code: string | null; readonly message: string }
    }
    expect(body.error.code).toBe("report_too_large")
    expect(body.error.message).toContain("USAGE_REPORT_MAX_ROWS")
    expect(await count()).toBe(before)
  })
})
