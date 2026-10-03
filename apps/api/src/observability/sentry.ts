import { UNKNOWN_REVISION, VERSION } from "@multi-ai-router/core"
import * as Sentry from "@sentry/bun"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import { redact } from "../logging/redact"

/**
 * GlitchTip (Sentry-protocol) error tracking for the router.
 *
 * The router's defining rule — upstream credentials never leave it (non-negotiable #3) — meets a
 * Sentry SDK that, by default, scrapes request headers, request bodies and breadcrumbs onto every
 * event. On this router those surfaces carry API keys, OAuth tokens and refresh codes, so an
 * unscrubbed event is a credential leak to GlitchTip. `beforeSend` runs the same `redact()` the
 * structured logger uses, while explicit collection limits prevent automatic collection of raw
 * payloads. Pure scrubber and real SDK transport tests pin that boundary as a security gate.
 *
 * Two further guards hold the overhead budget (non-negotiable #8 — added p99 under 5 ms, nothing
 * added to time-to-first-token):
 *
 * - No DSN (`SENTRY_DSN` unset) → `init` is never called. A dev, test or CI boot pays nothing and
 *   ships nothing; the SDK stays inert and `captureException` is a no-op without a transport.
 * - Tracing is off (`tracesSampleRate: 0`), OpenTelemetry global setup is skipped, and the
 *   request/fetch instrumentations are excluded by an explicit integration allowlist. The router
 *   makes an upstream call on every request, and patching global `fetch` plus `Bun.serve` to scope
 *   and breadcrumb
 *   each one is overhead on the happy path. Errors are captured explicitly in the Hono error
 *   handler instead — on the 5xx path, never the 200 one. The selected integrations only do
 *   work while an event is being assembled.
 */

/**
 * The depth a Sentry event is walked to. A Sentry event nests its stack at
 * `exception.values[].stacktrace.frames[].vars`; the log scrubber's default ceiling of 4 lands on
 * exactly `stacktrace` and would replace the whole trace with `[REDACTED]`, shipping errors with no
 * frames. Eight reaches the frame `vars` (scrubbed by name and value) while leaving `filename`,
 * `function`, `lineno` and the rest of the frame metadata intact — the diagnostic payload an error
 * tracker exists for. Anything deeper than a `vars` value fails closed to `[REDACTED]`, the safe
 * direction for a credential.
 */
const SENTRY_WALK_DEPTH = 8

/**
 * The pure half of `beforeSend`, exported so the redaction is unit-testable with no SDK, no clock
 * and no network. Runs the logger's `redact()` over a Sentry event — at the Sentry walk depth so
 * the stack survives — scrubbing field names (`authorization`, `cookie`, `x-api-key`, `*token*`, …)
 * and self-identifying credential value shapes (`sk-…`, JWTs, connection strings, every provider
 * prefix) alike, recursively. A Sentry event is a plain JSON object, so the same record walk the
 * logger uses covers it whole.
 */
export function redactSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  return redact(
    event as unknown as Record<string, unknown>,
    SENTRY_WALK_DEPTH,
  ) as unknown as Sentry.ErrorEvent
}

export function initSentry(
  env: Env,
  logger: Logger,
  transport?: Sentry.BunOptions["transport"],
): void {
  if (env.sentryDsn === null) return
  // Bun delegates to NodeClient, but v11.4's BunOptions omits this supported Node option.
  const options: Sentry.BunOptions & { enableRuntimeChannelInjection: false } = {
    dsn: env.sentryDsn,
    environment: env.sentryEnvironment,
    release: VERSION,
    // Explicit zero also overrides SENTRY_TRACES_SAMPLE_RATE inherited from the host.
    tracesSampleRate: 0,
    // The server client otherwise installs SpanStreaming even without default integrations.
    traceLifecycle: "static",
    enableOpenTelemetrySetup: false,
    // NodeClient otherwise registers runtime diagnostics injection independently of integrations.
    enableRuntimeChannelInjection: false,
    tracePropagationTargets: [],
    sendClientReports: false,
    // New SDK defaults must never silently install request or provider instrumentation.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.modulesIntegration(),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // v11 captures these APIs without an enable flag. Keep this transport errors-only.
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeSend: redactSentryEvent,
    ...(transport === undefined ? {} : { transport }),
  }
  Sentry.init(options)

  // `Sentry.init` does not throw on a malformed DSN — `makeDsn` rejects it silently, the client
  // gets no transport, and every capture is dropped. Surface that at boot, where a typo is
  // fixable, rather than at the first undiagnosed outage. An optional observability var must not
  // fail boot, so the schema stays lenient and the signal is this warn, not a parse error.
  if (Sentry.getClient()?.getDsn() === undefined) {
    logger.warn("SENTRY_DSN was rejected by the SDK — GlitchTip tracking is OFF; check the DSN", {
      component: "observability",
    })
    return
  }

  // Two builds can share a VERSION (a rebuilt tag, a dirty tree); the commit sha is what separates
  // them, so it rides as a tag the way `router_build_info{revision}` does for metrics.
  if (env.revision !== UNKNOWN_REVISION) {
    Sentry.setTag("router_revision", env.revision)
  }

  logger.info("glitchtip error tracking enabled", {
    component: "observability",
    environment: env.sentryEnvironment,
    release: VERSION,
  })
}

/**
 * Captures a 5xx / unexpected error to GlitchTip. Safe to call unconditionally: when `initSentry`
 * was never called (no DSN — the dev/test/CI default) the SDK has no transport and the capture is
 * dropped, which is the correct behavior for a boot that opted out of tracking.
 *
 * `tags` are low-cardinality fields GlitchTip groups and filters on (error class, status, path);
 * `extra` carries the per-request id without bloating the tag index.
 */
export function captureException(
  error: unknown,
  context?: {
    readonly tags?: Record<string, string | number | null>
    readonly extra?: Record<string, unknown>
  },
): void {
  Sentry.captureException(error, {
    ...(context?.tags ? { tags: context.tags } : {}),
    ...(context?.extra ? { extra: context.extra } : {}),
  })
}
