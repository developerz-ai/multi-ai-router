import type { MiddlewareHandler } from "hono"
import type { LogFields, Logger } from "../logging/logger"
import type { AppEnv } from "../types"

/**
 * Binds a request-scoped logger onto the context and writes exactly **one** transport line per
 * request when it ends: `request completed` — `info`, or `debug` for a quiet path that answered
 * normally — or, for a request the error handler rendered, `request failed` at the level the
 * handler chose, carrying the handler's fields and this line's timing. One line, not two: a failed
 * request used to log both, and the pair was half the bytes of a production week's log.
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

/**
 * What a *failed* request additionally says about the body it carried — the four facts that tell an
 * empty body from a compressed one from a client that sent a form. A week of identical
 * "must name a model" refusals from one key was undiagnosable without them. On the failure line
 * only: `user-agent` on every completed line is volume for nothing.
 *
 * Same allowlist rule as above — none of these carries a credential, and nothing unnamed is read.
 */
const FAILURE_HEADERS: readonly string[] = [
  ...LOGGED_HEADERS,
  "content-type",
  "content-encoding",
  "content-length",
  "user-agent",
]

/** The named headers this request actually carried. Absent ones are absent, never null. */
function headerContext(headers: Headers, names: readonly string[]): Record<string, string> {
  const context: Record<string, string> = {}
  for (const name of names) {
    const value = headers.get(name)?.trim()
    if (value !== undefined && value.length > 0) context[name] = value.slice(0, MAX_HEADER_LENGTH)
  }
  return context
}

/** The context of the `request failed` line (`errorHandler.ts`). */
export function failureContext(headers: Headers): Record<string, string> {
  return headerContext(headers, FAILURE_HEADERS)
}

/** What the error handler knows about a failed request, held until its one line is written. */
export interface RequestFailure {
  readonly level: "info" | "warn" | "error"
  readonly fields: LogFields
}

/**
 * Requests a `requestLogger` is tracking, keyed by the request object itself so nothing has to be
 * declared on the context type. An entry is `null` until the error handler records a failure; a
 * request absent from the map has no completion line coming, so its failure must log on its own.
 */
const tracked = new WeakMap<Request, RequestFailure | null>()

/**
 * Hands a failure to the request's completion line. Returns `false` when no request logger is
 * tracking this request — an error raised before the middleware ran, or an app built without
 * it — and the caller must then write its own line, or the failure would go unlogged.
 */
export function deferFailureLine(request: Request, failure: RequestFailure): boolean {
  if (!tracked.has(request)) return false
  tracked.set(request, failure)
  return true
}

export interface RequestLoggerOptions {
  /**
   * `LOG_QUIET_PATHS`: exact paths whose *successful* completions log at `debug`. A liveness probe
   * every few seconds is thousands of identical lines a day, and they bury the traffic an operator
   * opened the log to read. A probe that fails keeps its normal level — that line is the point.
   */
  readonly quietPaths?: readonly string[]
}

/**
 * A streamed body is still flowing when this middleware resumes: what it can time is the headers.
 * The line says so under its own name instead of passing time-to-headers off as `durationMs`; the
 * stream's whole lifetime is on the usage record and `router_request_duration_seconds`.
 */
function isStreamed(response: Response): boolean {
  return response.headers.get("content-type")?.startsWith("text/event-stream") === true
}

export function requestLogger(
  base: Logger,
  options: RequestLoggerOptions = {},
): MiddlewareHandler<AppEnv> {
  const quiet = new Set(options.quietPaths ?? [])

  return async (c, next) => {
    const log = base.child({ component: "transport", requestId: c.get("requestId") })
    c.set("log", log)
    const request = c.req.raw
    tracked.set(request, null)

    const startedAt = performance.now()
    await next()

    const failure = tracked.get(request) ?? null
    tracked.delete(request)
    const elapsedMs = Math.round(performance.now() - startedAt)
    const status = c.res.status
    const timing = isStreamed(c.res)
      ? { streamed: true, timeToHeadersMs: elapsedMs }
      : { durationMs: elapsedMs }
    const common = { method: c.req.method, path: c.req.path, status, ...timing }
    if (failure === null) {
      const level = status < 400 && quiet.has(c.req.path) ? "debug" : "info"
      log[level]("request completed", {
        ...common,
        ...headerContext(request.headers, LOGGED_HEADERS),
      })
      return
    }
    log[failure.level]("request failed", {
      ...common,
      ...failureContext(request.headers),
      ...failure.fields,
    })
  }
}
