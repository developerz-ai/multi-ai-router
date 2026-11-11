import { atLeastOne, wholeNumber } from "./fields"

/**
 * Bounds and lifetimes that were constants in code (CLAUDE.md non-negotiable 11), grouped by the
 * module that reads them. Each default is the value the code used before it became a setting, or —
 * where the code had no bound at all — the bound docs/idea/09-deployment.md#environment-reference
 * argues for.
 */
export const RUNTIME_LIMIT_ENV_FIELDS = {
  // Database session timeouts (postgres.js `connection` parameters). Zero is Postgres' own "off".
  DB_STATEMENT_TIMEOUT_MS: wholeNumber.optional(),
  DB_LOCK_TIMEOUT_MS: wholeNumber.optional(),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: wholeNumber.optional(),
  // Router-key verification.
  KEY_CACHE_NEGATIVE_MAX: atLeastOne.optional(),
  KEY_VERIFY_MAX_PENDING: atLeastOne.optional(),
  KEY_CACHE_STALE_ON_ERROR_SECONDS: wholeNumber.optional(),
  // Transport and observability.
  TRUST_PROXY_HOPS: atLeastOne.optional(),
  METRICS_MAX_SERIES_PER_METRIC: atLeastOne.optional(),
  HEALTH_DB_PROBE_TIMEOUT_MS: atLeastOne.optional(),
  SENTRY_EXIT_FLUSH_MS: atLeastOne.optional(),
  // Zero is a setting: resolve the `claude` binary on every `/readyz`.
  HEALTH_CLI_PROBE_CACHE_MS: wholeNumber.optional(),
  ACCOUNT_RECHECK_ALL_CONCURRENCY: atLeastOne.optional(),
  // Routing.
  ROUTING_MAX_REPORTED_RESET_SECONDS: atLeastOne.optional(),
  LEAST_USED_TOKEN_WINDOW_SECONDS: atLeastOne.optional(),
  MODEL_REFUSAL_TTL_SECONDS: atLeastOne.optional(),
  // Upstream model listings and plan-quota reads.
  MODEL_LISTING_MAX_BYTES: atLeastOne.optional(),
  UPSTREAM_BUFFERED_BODY_MAX_BYTES: atLeastOne.optional(),
  UPSTREAM_STREAM_CAP_MIN_SECONDS: atLeastOne.optional(),
  // Database housekeeping.
  DB_MIGRATION_LOCK_TIMEOUT_MS: atLeastOne.optional(),
  ACCOUNT_LAST_USED_STAMP_INTERVAL_SECONDS: wholeNumber.optional(),
  USAGE_BACKFILL_FULL_SCAN_HOURS: atLeastOne.optional(),
  // Usage writer.
  USAGE_RETRY_BUFFER_MAX: atLeastOne.optional(),
  // Admin OIDC.
  ADMIN_OIDC_DISCOVERY_TTL_SECONDS: atLeastOne.optional(),
  ADMIN_OIDC_JWKS_TTL_SECONDS: atLeastOne.optional(),
  // Scheduler.
  SCHEDULER_TASK_MAX_RUN_MINUTES: atLeastOne.optional(),
  MODEL_CATALOG_REFRESH_STARTUP_DELAY_SECONDS: wholeNumber.optional(),
}

type RuntimeLimitEnv = { readonly [K in keyof typeof RUNTIME_LIMIT_ENV_FIELDS]?: number }

export function readRuntimeLimitsEnv(raw: RuntimeLimitEnv) {
  return {
    keyVerification: {
      // Its own bound, so a flood of unknown keys can never evict a verified one.
      negativeCacheMax: raw.KEY_CACHE_NEGATIVE_MAX ?? 1_024,
      // Concurrent cache-miss lookups; well under the main pool so a spray cannot occupy it.
      maxPendingLoads: raw.KEY_VERIFY_MAX_PENDING ?? 32,
      // How long a verified key keeps being served when its reload fails on a store error.
      staleOnErrorSeconds: raw.KEY_CACHE_STALE_ON_ERROR_SECONDS ?? 900,
    },
    trustProxyHops: raw.TRUST_PROXY_HOPS ?? 1,
    metricsMaxSeriesPerMetric: raw.METRICS_MAX_SERIES_PER_METRIC ?? 4_096,
    healthDatabaseProbeTimeoutMs: raw.HEALTH_DB_PROBE_TIMEOUT_MS ?? 2_000,
    // How long a boot failure or crash waits for GlitchTip before the process exits.
    sentryExitFlushMs: raw.SENTRY_EXIT_FLUSH_MS ?? 2_000,
    healthCliProbeCacheMs: raw.HEALTH_CLI_PROBE_CACHE_MS ?? 5_000,
    // Accounts "Re-check all" probes at once.
    accountRecheckAllConcurrency: raw.ACCOUNT_RECHECK_ALL_CONCURRENCY ?? 4,
    routingLimits: {
      // Eight days: the longest documented provider window is weekly.
      maxReportedResetSeconds: raw.ROUTING_MAX_REPORTED_RESET_SECONDS ?? 691_200,
      leastUsedTokenWindowSeconds: raw.LEAST_USED_TOKEN_WINDOW_SECONDS ?? 3_600,
      // How long an account's refusal of a model keeps it out of that model's candidates.
      modelRefusalTtlSeconds: raw.MODEL_REFUSAL_TTL_SECONDS ?? 3_600,
    },
    // A provider's model listing or plan-quota body read past this is refused, never buffered.
    modelListingMaxBytes: raw.MODEL_LISTING_MAX_BYTES ?? 8_388_608,
    // An upstream body the router must read whole (translated JSON, folded or coerced streams).
    upstreamBufferedBodyMaxBytes: raw.UPSTREAM_BUFFERED_BODY_MAX_BYTES ?? 33_554_432,
    // An upstream-dropped, never-completed stream at least this old is the provider's own cap
    // (Codex ~900 s), not a fault of the account (`dataplane/stream-cap.ts`).
    upstreamStreamCapMinSeconds: raw.UPSTREAM_STREAM_CAP_MIN_SECONDS ?? 840,
    // How long a boot migration waits for a lock before failing rather than queueing every query.
    migrationLockTimeoutMs: raw.DB_MIGRATION_LOCK_TIMEOUT_MS ?? 10_000,
    // `accounts.last_used_at` is stamped at most once per interval per account.
    accountLastUsedStampIntervalSeconds: raw.ACCOUNT_LAST_USED_STAMP_INTERVAL_SECONDS ?? 60,
    usageBackfillFullScanHours: raw.USAGE_BACKFILL_FULL_SCAN_HOURS ?? 24,
    // Records a transient database outage may hold for retry before the oldest are dropped.
    usageRetryBufferMax: raw.USAGE_RETRY_BUFFER_MAX ?? 10_000,
    oidcCache: {
      discoveryTtlSeconds: raw.ADMIN_OIDC_DISCOVERY_TTL_SECONDS ?? 86_400,
      jwksTtlSeconds: raw.ADMIN_OIDC_JWKS_TTL_SECONDS ?? 3_600,
    },
    schedulerLimits: {
      taskMaxRunMinutes: raw.SCHEDULER_TASK_MAX_RUN_MINUTES ?? 60,
      modelCatalogRefreshStartupDelaySeconds: raw.MODEL_CATALOG_REFRESH_STARTUP_DELAY_SECONDS ?? 30,
    },
  }
}

export type RuntimeLimitsConfig = ReturnType<typeof readRuntimeLimitsEnv>
