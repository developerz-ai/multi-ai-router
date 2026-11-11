import type { Dialect } from "@multi-ai-router/core"
import type { MiddlewareHandler } from "hono"
import type { RequestObserver } from "../services/dataplane"
import { outcomeOf } from "../services/usage"
import type { RouterKeyEnv } from "./routerKeyAuth"

/**
 * Requests the dispatcher took over. From that moment its own accounting counts the request in
 * `router_requests_total`, exactly once, whatever happens next.
 */
const dispatched = new WeakSet<Request>()

/** Called by the data-plane handler immediately before it hands the request to the dispatcher. */
export function markDispatched(request: Request): void {
  dispatched.add(request)
}

/** The `key_id` label of a request refused before any key verified. Bounded: one series. */
export const UNVERIFIED_KEY_ID = "none"

/**
 * Counts a data-plane request that ended **before** the dispatcher saw it — an unknown or revoked
 * key, a key store that could not answer, any throw in the guard — so `router_requests_total`
 * sees every request that reached a data-plane route, not only those that got as far as routing.
 * Without it a key-store outage's 503s (or a stray 500 in the guard) were invisible to every alert
 * built on that counter (tesote, 2.56.0).
 *
 * Mounted first on each inference route. A request the dispatcher took over is left to the
 * dispatcher, so nothing is counted twice. A body Bun itself refuses (over `maxRequestBodySize`)
 * never reaches the app and is not counted here.
 */
export function countUndispatched(
  ingress: Dialect,
  observe: RequestObserver | undefined,
): MiddlewareHandler<RouterKeyEnv> {
  return async (c, next) => {
    if (observe === undefined) return next()
    const startedAt = performance.now()
    let thrown: { readonly error: unknown } | undefined
    try {
      await next()
    } catch (error) {
      thrown = { error }
    }
    if (!dispatched.has(c.req.raw)) {
      // Hono hands a downstream throw to the error handler and sets `c.error`; a throw that
      // escaped it is the other spelling of the same failure.
      const error = thrown?.error ?? c.error
      observe({
        ingressDialect: ingress,
        model: null,
        keyId: c.get("routerKey")?.id ?? UNVERIFIED_KEY_ID,
        outcome:
          error !== undefined ? outcomeOf(error) : c.res.status < 400 ? "success" : "router_error",
        durationMs: performance.now() - startedAt,
        streamed: false,
      })
    }
    if (thrown !== undefined) throw thrown.error
  }
}
