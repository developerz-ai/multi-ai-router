import { describe, expect, test } from "bun:test"
import { AdminAuthError } from "@multi-ai-router/core"
import type { RecentAttemptRow, UsageOutcomeCount, UsageTotals } from "@multi-ai-router/db"
import { Hono, type MiddlewareHandler } from "hono"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthEnv, AdminAuthGuardService } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createUsageService } from "../../src/services/usage-read"

/**
 * The two halves of the *"why did my request fail"* surface, driven through a real Hono mount:
 * the live request feed, and the failure split on the summary beside it.
 *
 * The routes are thin, so what this proves is the wiring around them: the guard is carried, the
 * query is validated at the edge rather than in the service, and a rejected query is a `400` with
 * a reason instead of a page that quietly means something else. The services' own behaviour is a
 * unit test (`test/unit/usage/`) because it needs no HTTP to be true.
 */

const NOW = new Date("2026-07-24T12:00:00.000Z")

function attemptRow(over: Partial<RecentAttemptRow> = {}): RecentAttemptRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    correlationId: "11111111-1111-4111-8111-111111111111",
    clientRequestId: "req-42",
    attempt: 2,
    apiKeyId: "key-1",
    accountId: "acct-1",
    poolId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    upstreamModel: "claude-sonnet-5",
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    outcome: "upstream_error",
    httpStatus: 503,
    errorClass: "UpstreamError",
    latencyMs: 412,
    ttfbMs: null,
    routerOverheadMs: 3,
    streamed: false,
    tokensIn: 0,
    tokensOut: 0,
    createdAt: NOW,
    ...over,
  }
}

function harness(rows: readonly RecentAttemptRow[] = [attemptRow()], guard = stubSession()) {
  const unreached = () => {
    throw new Error("the feed must not read an aggregate")
  }

  const service = createUsageService({
    usage: {
      totals: unreached,
      latency: unreached,
      series: unreached,
      seriesByDimension: unreached,
      breakdown: unreached,
      outcomes: unreached,
    },
    recent: { recent: async () => [...rows] },
    daily: { totals: unreached, breakdown: unreached },
    scheduledTasks: { lastSuccess: unreached },
    labels: async () => ({
      keys: new Map([["key-1", "dev-laptops"]]),
      accounts: new Map([["acct-1", "claude-max-01"]]),
      pools: new Map(),
    }),
    now: () => NOW,
  })

  const app = new Hono<AdminAuthEnv>()
  const logger = createLogger({ level: "error", write: () => {} })
  app.use("*", requestId())
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(ADMIN_USAGE_BASE_PATH, adminUsageRoutes({ guard, service }))
  return app
}

describe("GET /api/admin/usage/recent", () => {
  test("answers the feed without shadowing the summary route beside it", async () => {
    const response = await harness().request("/api/admin/usage/recent")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { attempts: unknown[]; limit: number }
    expect(body.limit).toBe(50)
    expect(body.attempts).toHaveLength(1)
  })

  test("names the subjects and carries the diagnosis, marking what no longer exists", async () => {
    const response = await harness([attemptRow({ apiKeyId: "key-gone" })]).request(
      "/api/admin/usage/recent",
    )

    const body = (await response.json()) as {
      attempts: readonly Record<string, unknown>[]
    }
    expect(body.attempts[0]).toMatchObject({
      clientRequestId: "req-42",
      attempt: 2,
      outcome: "upstream_error",
      // Resolved by the router from `outcome`, so the console needs no copy of the taxonomy.
      fault: "upstream",
      httpStatus: 503,
      errorClass: "UpstreamError",
      latencyMs: 412,
      // A key purged 30 days after revocation still names the attempt it made.
      key: { id: "key-gone", label: null, note: "deleted" },
      account: { id: "acct-1", label: "claude-max-01", note: null },
      // Scope was `all` or an explicit account list, so no pool was ever involved.
      pool: { id: null, label: null, note: "none" },
    })
  })

  test("refuses a limit outside the accepted range rather than clamping it", async () => {
    const response = await harness().request("/api/admin/usage/recent?limit=1000")

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(JSON.stringify(body)).toContain("limit")
  })

  test("refuses an outcome and a failed flag together, and says why", async () => {
    const response = await harness().request(
      "/api/admin/usage/recent?outcome=upstream_error&failed=true",
    )

    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain("not both")
  })

  test("is unreachable without an admin session", async () => {
    const app = harness([attemptRow()], adminAuth(refusingAuth(), true))

    const response = await app.request("/api/admin/usage/recent")

    expect(response.status).toBe(401)
  })
})

describe("GET /api/admin/usage — the failure split", () => {
  test("carries the error rate taken apart, with quota and credits as two numbers", async () => {
    const response = await summaryHarness([
      { outcome: "success", attempts: 90 },
      { outcome: "quota_exhausted", attempts: 6 },
      { outcome: "credits_exhausted", attempts: 3 },
      { outcome: "scope_violation", attempts: 1 },
    ]).request("/api/admin/usage?window=today")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { failures: Record<string, unknown> }
    expect(body.failures).toEqual({
      attempts: 100,
      errors: 10,
      partial: false,
      // Biggest first, and never one "capacity" figure: waiting fixes the first, only a
      // top-up fixes the second, and an operator reading one number cannot tell which.
      byOutcome: [
        { outcome: "quota_exhausted", attempts: 6 },
        { outcome: "credits_exhausted", attempts: 3 },
        { outcome: "scope_violation", attempts: 1 },
      ],
    })
  })

  test("never reports success as a failure, while still counting it in the denominator", async () => {
    const response = await summaryHarness([{ outcome: "success", attempts: 12 }]).request(
      "/api/admin/usage?window=today",
    )

    const body = (await response.json()) as {
      failures: { attempts: number; errors: number; byOutcome: readonly { outcome: string }[] }
    }
    expect(body.failures.attempts).toBe(12)
    expect(body.failures.errors).toBe(0)
    expect(body.failures.byOutcome).toEqual([])
  })

  test("is unreachable without an admin session", async () => {
    const app = summaryHarness([], adminAuth(refusingAuth(), true))

    expect((await app.request("/api/admin/usage?window=today")).status).toBe(401)
  })
})

/**
 * The summary mount. Separate from the feed's harness because the two read opposite halves of the
 * service: this one serves aggregates and refuses to touch raw attempt rows, the other the
 * reverse — and a harness that answered both would prove neither stayed on its own side.
 *
 * Only `outcomes` and `totals` carry data; every other aggregate is empty, because the split is
 * the one thing under test and an empty series still renders a dense axis.
 */
function summaryHarness(outcomes: readonly UsageOutcomeCount[], guard = stubSession()) {
  const attempts = outcomes.reduce((sum, row) => sum + row.attempts, 0)
  const service = createUsageService({
    usage: {
      totals: async () => ({ ...ZERO_TOTALS, attempts }),
      latency: async () => ({
        p50Ms: null,
        p95Ms: null,
        routerOverheadP95Ms: null,
        ttfbP95Ms: null,
      }),
      series: async () => [],
      seriesByDimension: async () => [],
      breakdown: async () => [],
      outcomes: async () => [...outcomes],
    },
    recent: {
      recent: async () => {
        throw new Error("the summary must not read raw attempt rows")
      },
    },
    // `today` has no closed days, so the rolled table is never the right answer here.
    daily: {
      totals: async () => {
        throw new Error("the rolled table must not be read for a same-day window")
      },
      breakdown: async () => {
        throw new Error("the rolled table must not be read for a same-day window")
      },
    },
    scheduledTasks: { lastSuccess: async () => undefined },
    labels: async () => ({ keys: new Map(), accounts: new Map(), pools: new Map() }),
    now: () => NOW,
  })

  const app = new Hono<AdminAuthEnv>()
  const logger = createLogger({ level: "error", write: () => {} })
  app.use("*", requestId())
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(ADMIN_USAGE_BASE_PATH, adminUsageRoutes({ guard, service }))
  return app
}

const ZERO_TOTALS: UsageTotals = {
  requests: 0,
  attempts: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: "0",
  costNotional: "0",
}

function stubSession(): MiddlewareHandler<AdminAuthEnv> {
  return async (c, next) => {
    c.set("adminSession", {
      id: "session-1",
      username: "admin",
      csrfToken: "csrf",
      createdAtMs: NOW.getTime(),
      lastSeenAtMs: NOW.getTime(),
    })
    await next()
  }
}

/**
 * A cookie-less request, answered the way the real service answers one. The guard itself is
 * covered by `admin-auth.test.ts`; what this proves is that this mount runs it at all — the
 * failure it rules out is a route group shipped without its guard.
 */
function refusingAuth(): AdminAuthGuardService {
  return {
    authenticate: async () => {
      throw new AdminAuthError("Admin authentication required")
    },
    assertCsrf: () => {
      throw new Error("a GET is not a mutating method and must never reach CSRF")
    },
  }
}
