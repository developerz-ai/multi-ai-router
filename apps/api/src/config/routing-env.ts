import { DEFAULT_MAX_BODY_BYTES } from "../services/dataplane/body/read"
import type { DataPlaneConfig, FailoverConfig, TranslationConfig } from "./env-routing-types"
import type { ParsedEnv } from "./env-schema"

/** The request path's caches, writer, failover and translation knobs — split from `env-reader.ts`. */
export function readRoutingEnv(raw: ParsedEnv): {
  readonly dataPlane: DataPlaneConfig
  readonly failover: FailoverConfig
  readonly translation: TranslationConfig
} {
  return {
    // Defaults mirror the layer constants they override, so an unset variable
    // and a variable set to the default behave identically.
    dataPlane: {
      catalogRefreshSeconds: raw.CATALOG_REFRESH_SECONDS ?? 30,
      keyCacheMax: raw.KEY_CACHE_MAX ?? 4_096,
      keyCacheTtlSeconds: raw.KEY_CACHE_TTL_SECONDS ?? 60,
      keyCacheNegativeTtlSeconds: raw.KEY_CACHE_NEGATIVE_TTL_SECONDS ?? 5,
      sessionCacheMax: raw.SESSION_CACHE_MAX ?? 4_096,
      sessionCacheTtlSeconds: raw.SESSION_CACHE_TTL_SECONDS ?? 300,
      sessionCacheNegativeTtlSeconds: raw.SESSION_CACHE_NEGATIVE_TTL_SECONDS ?? 30,
      usageQueueMax: raw.USAGE_QUEUE_MAX ?? 10_000,
      usageBatchSize: raw.USAGE_BATCH_SIZE ?? 200,
      usageFlushIntervalMs: raw.USAGE_FLUSH_INTERVAL_MS ?? 1_000,
      usageLogReportIntervalMs: raw.USAGE_LOG_REPORT_INTERVAL_MS ?? 60_000,
      quotaWriteIntervalMs: raw.QUOTA_WRITE_INTERVAL_MS ?? 5_000,
      accountStatusWriteIntervalMs: raw.ACCOUNT_STATUS_WRITE_INTERVAL_MS ?? 1_000,
      maxRequestBodyBytes: raw.MAX_REQUEST_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES,
      maximumJsonDepth: raw.MAX_REQUEST_JSON_DEPTH ?? 256,
    },
    failover: {
      maxAttempts: raw.ROUTING_MAX_ATTEMPTS,
      overloadRetries: raw.ROUTING_OVERLOAD_RETRIES ?? 2,
      overloadRetryBaseMs: raw.ROUTING_OVERLOAD_RETRY_BASE_MS ?? 1_000,
      failureThreshold: raw.ROUTING_FAILURE_THRESHOLD ?? 3,
      baseBackoffMs: raw.ROUTING_BASE_BACKOFF_MS ?? 1_000,
      maxBackoffMs: raw.ROUTING_MAX_BACKOFF_MS ?? 300_000,
      authFailureCooldownMs: raw.ROUTING_AUTH_FAILURE_COOLDOWN_MS ?? 900_000,
      authFailureMaxCooldownMs: raw.ROUTING_AUTH_FAILURE_MAX_COOLDOWN_MS ?? 14_400_000,
      halfOpenHoldMs: raw.ROUTING_HALF_OPEN_HOLD_MS ?? 30_000,
      unknownResetRetryAfterSeconds: raw.ROUTING_UNKNOWN_RESET_RETRY_AFTER_SECONDS ?? 30,
      upstreamTimeoutMs: raw.UPSTREAM_TIMEOUT_MS ?? 600_000,
      upstreamErrorMaxBytes: raw.UPSTREAM_ERROR_MAX_BYTES ?? 65_536,
      responseObservationMaxBytes: raw.UPSTREAM_RESPONSE_OBSERVATION_MAX_BYTES ?? 65_536,
      boundAccountCoolingDown: raw.ROUTING_BOUND_ACCOUNT_COOLING_DOWN ?? "fail",
    },
    translation: {
      defaultMaxTokens: raw.TRANSLATE_DEFAULT_MAX_TOKENS ?? 4_096,
      maximumPendingBytes: raw.MAX_TRANSLATION_PENDING_BYTES ?? 1_048_576,
      thinkingDefaultModels: raw.OPENAI_CHAT_THINKING_DEFAULT_MODELS ?? [],
      maxSseFrameBytes: raw.MAX_TRANSLATION_SSE_FRAME_BYTES ?? 16_777_216,
      dropLogWindowSeconds: raw.TRANSLATION_DROP_LOG_WINDOW_SECONDS ?? 3_600,
    },
  }
}
