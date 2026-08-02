import { VERSION } from "@multi-ai-router/core"
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
 * structured logger uses — one scrubbing set, not two that drift — and that is the whole safety
 * argument. It is pinned as a security gate in `test/unit/observability/sentry.test.ts`.
 *
 * Two further guards hold the overhead budget (non-negotiable #8 — added p99 under 5 ms, nothing
 * added to time-to-first-token):
 *
 * - No DSN (`SENTRY_DSN` unset) → `init` is never called. A dev, test or CI boot pays nothing and
 *   ships nothing; the SDK stays inert and `captureException` is a no-op without a transport.
 * - Tracing is off, and the request/fetch instrumentations are stripped from the defaults. The
 *   router makes an upstream call on every request, and patching global `fetch` plus `Bun.serve` to
 *   scope and breadcrumb each one is overhead on the happy path. Errors are captured explicitly in
 *   the Hono error handler instead — on the 5xx path, never the 200 one. What remains of the
 *   defaults only does work while an event is being assembled.
 */

/**
 * Default integrations that touch the request critical path or add noise. Removed in `initSentry`;
 * everything else in `getDefaultIntegrationsWithoutPerformance` runs only when an event is built
 * (on error) or on a process crash.
 */
const HAPPY_PATH_INTEGRATIONS = new Set([
  // Structured logs are the source of truth here; console breadcrumbs are noise the SDK would
  // attach to every event for no diagnostic value.
  "Console",
  // Outgoing `http`/`https` instrumentation — an upstream call happens on every request, and
  // scoping each one is overhead the router's own logging already covers.
  "Http",
  // Outgoing `fetch` instrumentation — same hot path, to every provider driver.
  "NodeFetch",
  // Release-health session tracking — extra traffic, and the scope here is errors, not sessions.
  "ProcessSession",
  // Incoming `Bun.serve` instrumentation — every request, on the happy path.
  "BunServer",
])

/**
 * The pure half of `beforeSend`, exported so the redaction is unit-testable with no SDK, no clock
 * and no network. Runs the logger's `redact()` over a Sentry event: field names (`authorization`,
 * `cookie`, `x-api-key`, `*token*`, …) and self-identifying credential value shapes (`sk-…`, JWTs,
 * connection strings, every provider prefix) alike, recursively. A Sentry event is a plain JSON
 * object, so the same record walk the logger uses covers it whole.
 */
export function redactSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  return redact(event as unknown as Record<string, unknown>) as unknown as Sentry.ErrorEvent
}

export function initSentry(env: Env, logger: Logger): void {
  if (env.sentryDsn === null) return
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.sentryEnvironment,
    release: VERSION,
    // Errors only. No performance spans, and the request/fetch instrumentations stripped below —
    // together they keep the SDK off the request happy path entirely.
    tracesSampleRate: 0,
    integrations: (defaults) =>
      defaults.filter((integration) => !HAPPY_PATH_INTEGRATIONS.has(integration.name)),
    beforeSend: redactSentryEvent,
  })
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
