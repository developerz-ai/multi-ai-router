import { Hono } from "hono"
import { checkReadiness, type ReadinessProbes } from "../services/health/readiness"
import type { AppEnv } from "../types"

/**
 * Liveness and readiness are two different questions and two different endpoints.
 *
 * `GET /healthz` — the process is up and serving. Never touches the database: zero healthy
 *   accounts or an unreachable Postgres is an operator problem, not a reason for an
 *   orchestrator to restart a working process.
 * `GET /readyz` — the database is reachable. `503` with a short reason otherwise.
 *   The account pool is **reported** here but does not gate the answer: requiring a healthy
 *   account would deadlock a fresh install, which has none and needs traffic routed to its
 *   console in order to get one. See `services/health/readiness.ts`.
 *
 * docs/idea/08-observability.md#endpoints
 */
export function healthRoutes(probes: ReadinessProbes): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get("/healthz", (c) => c.json({ status: "ok" }))

  routes.get("/readyz", async (c) => {
    const report = await checkReadiness(probes)
    return c.json(
      {
        status: report.ready ? "ready" : "not_ready",
        checks: report.checks,
        reason: report.reason,
      },
      report.ready ? 200 : 503,
    )
  })

  return routes
}
