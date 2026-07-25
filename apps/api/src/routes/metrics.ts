import { Hono } from "hono"
import type { RouterMetrics } from "../observability"
import { timingSafeEqualStrings } from "../services/admin-auth"
import { bearerToken } from "../services/dataplane"
import type { AppEnv } from "../types"

/**
 * `GET /metrics` — Prometheus text exposition (docs/idea/08-observability.md#endpoints).
 *
 * **Neither credential plane reaches this route.** A router key must not read the deployment's
 * account inventory, and an admin session cookie would make the endpoint unscrapeable by a
 * Prometheus that has no login. So it has an auth of its own: `METRICS_TOKEN` when the operator
 * sets one, and nothing when they do not — the unset case is the single-host deployment whose
 * `/metrics` is only reachable from inside its own network, and demanding a secret there would
 * mean the endpoint is simply never enabled.
 *
 * What it exposes is counts and identifiers: account ids, key ids, pool ids, model names,
 * statuses. Never a credential, never a prompt, never a session or request id.
 */

export interface MetricsRouteDeps {
  readonly metrics: Pick<RouterMetrics, "expose">
  /** `METRICS_TOKEN`. Null leaves the endpoint open — see the note above. */
  readonly token: string | null
}

/** Where these routes mount. Absolute, so the mount point is the root. */
export const METRICS_PATH = "/metrics"

/** The exposition format version Prometheus negotiates against. */
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

const UNAUTHORIZED = "This endpoint requires the metrics token"

export function metricsRoutes(deps: MetricsRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get(METRICS_PATH, (c) => {
    if (!authorized(deps.token, c.req.header("authorization"))) {
      return c.json({ error: { type: "unauthorized", message: UNAUTHORIZED } }, 401, {
        "www-authenticate": 'Bearer realm="metrics"',
      })
    }

    // Scrapes are cheap but not free — the gauges are sampled here, so a cached body would
    // report the account inventory as it stood at some earlier scrape.
    return c.text(deps.metrics.expose(), 200, {
      "content-type": CONTENT_TYPE,
      "cache-control": "no-store",
    })
  })

  return routes
}

/** Constant-time, because a scrape endpoint is as guessable a target as any other. */
function authorized(token: string | null, authorization: string | undefined): boolean {
  if (token === null) return true
  const presented = bearerToken(authorization)
  return presented !== null && timingSafeEqualStrings(token, presented)
}
