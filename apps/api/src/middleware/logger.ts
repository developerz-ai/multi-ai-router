import type { MiddlewareHandler } from "hono"
import type { Logger } from "../logging/logger"
import type { AppEnv } from "../types"

/**
 * Binds a request-scoped logger onto the context and writes one `info` line per completed
 * request. A request that throws is logged by the error handler instead, which is the only
 * place that knows the status it ended on.
 */

/**
 * Client headers worth having on every line, and nothing else.
 *
 * **Who the conversation is** — `x-session-id` is what the router keys an SDK session on
 * (`dataplane/body/session.ts`), and `x-parent-session-id` says this turn is a subagent's, running
 * concurrently with its parent by design and in a session of its own. Without both, a session
 * collision is invisible in production and can only be inferred from its damage: two requests
 * contending for one SDK session look exactly like one request that died, until you can see they
 * carried the same id.
 *
 * **Who is asking** — the three `x-opencode-*` values a box plugin sets. A fleet-wide symptom that
 * turns out to be one box, one client build, or one model is a different investigation from one
 * that is not, and that is the cheapest possible way to tell them apart.
 *
 * An allowlist rather than "log the headers": a request's headers carry credentials, and the way to
 * be sure none is logged is to name the ones that are not. Values are bounded for the same reason
 * the session key itself is — a hostile header must not become an unbounded log field.
 */
const LOGGED_HEADERS: readonly string[] = [
  "x-session-id",
  "x-parent-session-id",
  "x-opencode-client",
  "x-opencode-host",
  "x-opencode-model",
]

/** Long enough for a uuid and a build string, short enough that nothing can flood a line. */
const MAX_HEADER_LENGTH = 200

/** The logged headers this request actually carried. Absent ones are absent, never null. */
function clientContext(headers: Headers): Record<string, string> {
  const context: Record<string, string> = {}
  for (const name of LOGGED_HEADERS) {
    const value = headers.get(name)?.trim()
    if (value !== undefined && value.length > 0) context[name] = value.slice(0, MAX_HEADER_LENGTH)
  }
  return context
}

export function requestLogger(base: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const log = base.child({ component: "transport", requestId: c.get("requestId") })
    c.set("log", log)

    const startedAt = performance.now()
    await next()

    log.info("request completed", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...clientContext(c.req.raw.headers),
    })
  }
}
