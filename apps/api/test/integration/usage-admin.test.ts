import { describe, expect, test } from "bun:test"
import { AdminAuthError } from "@multi-ai-router/core"
import type { RecentAttemptRow } from "@multi-ai-router/db"
import { Hono, type MiddlewareHandler } from "hono"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthEnv, AdminAuthGuardService } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createUsageService } from "../../src/services/usage-read"

/**
 * `GET /api/admin/usage/recent` — the live request feed, driven through a real Hono mount.
 *
 * The route is thin, so what this proves is the wiring around it: the guard is carried, the query
 * is validated at the edge rather than in the service, and a rejected query is a `400` with a
 * reason instead of a page that quietly means something else. The service's own behaviour is a
 * unit test (`test/unit/usage/usage-recent.test.ts`) because it needs no HTTP to be true.
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
