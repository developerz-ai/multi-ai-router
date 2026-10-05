import { UNKNOWN_REVISION } from "@multi-ai-router/core"
import { DATABASE_POOL_DEFAULTS } from "@multi-ai-router/db"
import { z } from "zod"
import { CLI_REFRESH_LEAD_MS } from "../providers/claude-sdk/credential-freshness"
import { readAdminBodiesEnv } from "./admin-bodies"
import { readBackgroundEnv } from "./background"
import { readClaudeLoginEnv } from "./claude-login"
import { readCliOwnershipEnv } from "./cli-ownership"
import { DEFAULT_LOG_QUIET_PATHS, DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS } from "./env-defaults"
import { readAdminOidcEnv } from "./env-oidc"
import type { ParsedEnv } from "./env-schema"
import type { Env } from "./env-types"
import { readMetricInventoryEnv } from "./metric-inventory"
import { readRecoveryEnv } from "./recovery"
import { readRelayLifetimesEnv } from "./relay-lifetimes"
import { readUsageReadEnv } from "./usage-read"

export function readParsedEnv(raw: ParsedEnv, ctx: z.RefinementCtx): Env {
  const adminOidc = readAdminOidcEnv(raw, ctx)
  if (adminOidc === undefined) return z.NEVER

  // The CLI refreshes inside its own lead whether the router likes it or not, so a cold margin
  // narrower than that lets a turn-free probe start exactly the refresh it cannot finish — the
  // 2026-09-06/07 deauthentications, reinstated by a setting. Refused, not clamped: an operator who
  // typed a number meant it, and the boot log is where to learn it cannot be honoured.
  const coldMarginSeconds = raw.CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS ?? 600
  const cliLeadSeconds = CLI_REFRESH_LEAD_MS / 1_000
  if (coldMarginSeconds < cliLeadSeconds) {
    ctx.addIssue({
      code: "custom",
      path: ["CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS"],
      message:
        `must be at least ${cliLeadSeconds}: the claude CLI refreshes an access token within ` +
        `${cliLeadSeconds} s of its expiry on its own, and a turn-free probe spawned inside that ` +
        `lead is ended before the rotated refresh token is written — which deauthenticates the account`,
    })
    return z.NEVER
  }

  const sessionIdleMinutes = raw.ADMIN_SESSION_IDLE_MINUTES ?? 43_200
  const sessionTouchIntervalSeconds = raw.ADMIN_SESSION_TOUCH_INTERVAL_SECONDS ?? 60
  if (sessionTouchIntervalSeconds >= sessionIdleMinutes * 60) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_SESSION_TOUCH_INTERVAL_SECONDS"],
      message:
        `must be less than ADMIN_SESSION_IDLE_MINUTES * 60 (${sessionIdleMinutes * 60} seconds) ` +
        `so an active session is persisted before its idle window expires`,
    })
    return z.NEVER
  }

  const usageDays = raw.RETENTION_USAGE_DAYS ?? 90
  // Two years of daily aggregates: long enough that "what did this cost me last year" is still
  // answerable, and the first bound this table has ever had.
  const usageDailyDays = raw.RETENTION_USAGE_DAILY_DAYS ?? 730
  if (usageDailyDays < usageDays) {
    // Not clamped, because either value could be the one the operator meant and guessing which
    // silently discards history. A shorter history horizon permits deletion of unregistered
    // raw rows that should still be retained by the longer detail window.
    ctx.addIssue({
      code: "custom",
      path: ["RETENTION_USAGE_DAILY_DAYS"],
      message:
        `must be at least RETENTION_USAGE_DAYS (${usageDays}): daily aggregates are the long ` +
        `half of usage retention, and a shorter history horizon would permit deletion of ` +
        `unregistered raw detail that should still be retained`,
    })
    return z.NEVER
  }

  const claudeLogin = readClaudeLoginEnv(raw, ctx)
  if (claudeLogin === undefined) return z.NEVER

  return {
    ...claudeLogin,
    ...readRecoveryEnv(raw),
    ...readUsageReadEnv(raw),
    ...readAdminBodiesEnv(raw),
    ...readBackgroundEnv(raw),
    ...readRelayLifetimesEnv(raw),
    ...readMetricInventoryEnv(raw),
    ...readCliOwnershipEnv(raw),
    port: raw.PORT ?? 8080,
    serverIdleTimeoutSeconds:
      raw.SERVER_IDLE_TIMEOUT_SECONDS ?? DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
    // Fifteen seconds lets ordinary responses finish while leaving room for producer drains,
    // auxiliary pool closure and writer flushes within Compose's 60s grace. The image-pins
    // regression checks the complete shutdown budget, not just the HTTP drain.
    shutdownDrainMs: raw.SHUTDOWN_DRAIN_MS ?? 15_000,
    // Zero, so the bundled compose deployment shuts down exactly as fast as it used to: nothing
    // there polls readiness, so the window would buy an operator nothing and cost them seconds.
    shutdownReadyGraceMs: raw.SHUTDOWN_READY_GRACE_MS ?? 0,
    databaseUrl: raw.DATABASE_URL,
    databasePool: {
      maxConnections: raw.DB_POOL_MAX ?? DATABASE_POOL_DEFAULTS.maxConnections,
      idleTimeoutSeconds:
        raw.DB_POOL_IDLE_TIMEOUT_SECONDS ?? DATABASE_POOL_DEFAULTS.idleTimeoutSeconds,
      connectTimeoutSeconds:
        raw.DB_POOL_CONNECT_TIMEOUT_SECONDS ?? DATABASE_POOL_DEFAULTS.connectTimeoutSeconds,
      maxLifetimeSeconds:
        raw.DB_POOL_MAX_LIFETIME_SECONDS ?? DATABASE_POOL_DEFAULTS.maxLifetimeSeconds,
      closeTimeoutSeconds:
        raw.DB_POOL_CLOSE_TIMEOUT_SECONDS ?? DATABASE_POOL_DEFAULTS.closeTimeoutSeconds,
    },
    adminOidc,
    encryptionKey: raw.ENCRYPTION_KEY,
    logLevel: raw.LOG_LEVEL ?? "info",
    logReasonMaxChars: raw.LOG_REASON_MAX_CHARS ?? 200,
    logQuietPaths: raw.LOG_QUIET_PATHS ?? DEFAULT_LOG_QUIET_PATHS,
    trustProxy: raw.TRUST_PROXY ?? false,
    publicUrl: raw.PUBLIC_URL ?? null,
    revision: raw.ROUTER_REVISION ?? UNKNOWN_REVISION,
    webRoot: raw.WEB_ROOT ?? null,
    claudeConfigRoot: raw.CLAUDE_CONFIG_ROOT ?? "/data/claude",
    claudeCliPath: raw.CLAUDE_CLI_PATH ?? null,
    claudeSdkMaxConcurrency: raw.CLAUDE_SDK_MAX_CONCURRENCY ?? 10,
    claudeSdkMaxConcurrencyPerAccount: raw.CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT ?? 4,
    // How near an access token's expiry counts as "inside the refresh window", where only one
    // subprocess may cross at a time (`providers/claude-sdk/credential-freshness.ts`). 300 s is the
    // buffer Meridian settled on for the same token endpoint, and it comfortably covers a spawn
    // that begins just before expiry and refreshes just after.
    // On by default. The CLI persists a rotated refresh token only after the token endpoint
    // answers, and a turn-free probe is ended before that — so a cold credential is given one
    // small real turn first, and the turn-free gauge read follows it. The cost is one turn per
    // cold account per sweep; `false` leaves a cold account un-gauged and un-listed until a
    // client's turn refreshes it, and never spends its refresh token on a probe.
    claudeSdkCredentialKeepalive: raw.CLAUDE_SDK_CREDENTIAL_KEEPALIVE ?? true,
    // Ten minutes: the CLI's own five-minute lead (`CLI_REFRESH_LEAD_MS`), doubled, so a probe that
    // queued for a slot behind live traffic still cannot arrive inside the CLI's window. The floor
    // below refuses anything narrower than the CLI's lead — that setting is the bug, not a tuning.
    claudeSdkCredentialColdMarginSeconds: coldMarginSeconds,
    claudeSdkCredentialRefreshSkewSeconds: raw.CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS ?? 300,
    // How long a waiter gives the winner before proceeding regardless. A refresh is one HTTPS
    // round-trip inside a subprocess that was starting anyway; past this the gate has clearly not
    // helped, and a wedged Account would be a worse outage than the race.
    claudeSdkCredentialRefreshWaitMs: raw.CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS ?? 20_000,
    claudeSdkCredentialRefreshPollMs: raw.CLAUDE_SDK_CREDENTIAL_REFRESH_POLL_MS ?? 250,
    metricsToken: raw.METRICS_TOKEN ?? null,
    sentryDsn: raw.SENTRY_DSN ?? null,
    sentryEnvironment: raw.SENTRY_ENVIRONMENT ?? "production",
    adminApiToken: raw.ADMIN_API_TOKEN ?? null,
    accountRecheckCooldownSeconds: raw.ACCOUNT_RECHECK_COOLDOWN_SECONDS ?? 60,
    // Longer than the re-check default on purpose: this one costs money (and, on the Agent-SDK
    // path, a subprocess), so the button that spends it should not be as cheap to lean on.
    accountTestNowCooldownSeconds: raw.ACCOUNT_TEST_NOW_COOLDOWN_SECONDS ?? 120,
    adminCredentialMetadataTtlSeconds: raw.ADMIN_CREDENTIAL_METADATA_TTL_SECONDS ?? 60,
    claudeSdkUsageGauge: {
      enabled: raw.CLAUDE_SDK_USAGE_GAUGE ?? true,
      timeoutMs: raw.CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS ?? 5_000,
      minIntervalSeconds: raw.CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS ?? 60,
    },
    claudeSdkSessionCarry: {
      enabled: raw.CLAUDE_SDK_SESSION_CARRY ?? true,
      // 32 MiB: production's largest transcripts sit under 2 MB at a ~670k-token context, so this
      // is headroom, not a limit anyone meets — it only bounds what one carry holds in memory.
      maxBytes: raw.CLAUDE_SDK_SESSION_CARRY_MAX_BYTES ?? 33_554_432,
    },
    retention: {
      sessionsHours: raw.RETENTION_SESSIONS_HOURS ?? 24,
      usageDays,
      usageDailyDays,
      auditDays: raw.RETENTION_AUDIT_DAYS ?? 365,
      // A month of run rows: long enough to answer "has this task been failing all week", short
      // enough that six tasks ticking as often as every five minutes stay a table nobody notices.
      taskRunsDays: raw.RETENTION_TASK_RUNS_DAYS ?? 30,
      revokedKeysDays: raw.RETENTION_REVOKED_KEYS_DAYS ?? 30,
      oauthStateMinutes: raw.RETENTION_OAUTH_STATE_MINUTES ?? 10,
      // A day, because the failure it covers is a crash between provisioning a directory and
      // inserting the row that names it, and the operator who notices at all notices the next
      // morning. Shortening it buys a little disk and risks deleting a live login.
      orphanConfigDirHours: raw.RETENTION_ORPHAN_CONFIG_DIR_HOURS ?? 24,
      // The same day the idle-session row gets, so the file and the row that resumes it age out
      // together. Longer keeps warm resumes for conversations that pause overnight; shorter
      // trades disk for a cold replay on the next turn.
      sdkTranscriptHours: raw.RETENTION_SDK_TRANSCRIPT_HOURS ?? 24,
    },
    janitorIntervalMinutes: raw.JANITOR_INTERVAL_MINUTES ?? 60,
    scheduler: {
      lockPoolMaxConnections: raw.SCHEDULER_LOCK_POOL_MAX_CONNECTIONS ?? 1,
      localCapacityRetryMs: raw.SCHEDULER_LOCAL_CAPACITY_RETRY_MS ?? 1_000,
      usageRollupIntervalMinutes: raw.USAGE_ROLLUP_INTERVAL_MINUTES ?? 60,
      oauthStatePurgeIntervalMinutes: raw.OAUTH_STATE_PURGE_INTERVAL_MINUTES ?? 5,
      quotaFloorIntervalMinutes: raw.QUOTA_FLOOR_INTERVAL_MINUTES ?? 30,
      // Hours, not minutes: an orphan is a crash artifact, so a router that never crashes sweeps
      // an empty root forever and one that did leaves a directory nobody is racing to reclaim.
      configDirReapIntervalMinutes: raw.CONFIG_DIR_REAP_INTERVAL_MINUTES ?? 360,
      // Hourly, like the janitor it mirrors: a transcript becomes removable once an hour at the
      // most, and a sweep is a directory walk over a few thousand names, not a subprocess.
      sdkTranscriptSweepIntervalMinutes: raw.SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES ?? 60,
      // Minutes, not hours: an idle console session outlives its own expiry by up to one tick's
      // worth of memory, and a login-heavy operator day should not let that pile up for hours.
      adminSessionPurgeIntervalMinutes: raw.ADMIN_SESSION_PURGE_INTERVAL_MINUTES ?? 30,
      // Daily. Each account is still only touched once per idle window — see the field note.
      // 6 h, not 24. A subscription's access token lives ~8 h, so a daily sweep cannot keep one
      // warm however well it works — it wakes up long after the credential has gone cold. This is
      // the cadence the keepalive needs; the sweep's other halves are free and unbothered by it.
      idleAccountProbeIntervalMinutes: raw.IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES ?? 360,
      idleAccountAfterDays: raw.IDLE_ACCOUNT_AFTER_DAYS ?? 7,
      idleAccountProbeBatchSize: raw.IDLE_ACCOUNT_PROBE_BATCH_SIZE ?? 5,
      idleAccountProbePaidTurn: raw.IDLE_ACCOUNT_PROBE_PAID_TURN ?? false,
      // Hourly, and a batch that covers a normal fleet in one tick. Bigger than the keepalive's
      // five because these are plain GETs against a listing endpoint, not billed turns.
      modelCatalogRefreshIntervalMinutes: raw.MODEL_CATALOG_REFRESH_INTERVAL_MINUTES ?? 60,
      modelCatalogRefreshBatchSize: raw.MODEL_CATALOG_REFRESH_BATCH_SIZE ?? 25,
      sweepBatchSize: raw.SWEEP_BATCH_SIZE ?? 1_000,
      jitterFraction: raw.SCHEDULER_JITTER_FRACTION ?? 0.2,
    },
    oauthRefresh: {
      lockPoolMaxConnections: raw.OAUTH_REFRESH_LOCK_POOL_MAX_CONNECTIONS ?? 1,
      leadFraction: raw.OAUTH_REFRESH_LEAD_FRACTION ?? 0.75,
      minDelaySeconds: raw.OAUTH_REFRESH_MIN_DELAY_SECONDS ?? 30,
      maxAttempts: raw.OAUTH_REFRESH_MAX_ATTEMPTS ?? 5,
    },
    adminAuth: {
      // Thirty days on both bounds: a single-operator console behind SSO, redeployed weekly, whose
      // sessions now live in Postgres — the eight-hour idle window only ever logged the operator
      // out. The trade (a stolen cookie lives up to 30 d; logout is a real invalidation) is
      // written down in docs/idea/13-admin-oidc.md.
      sessionIdleMinutes,
      sessionAbsoluteHours: raw.ADMIN_SESSION_ABSOLUTE_HOURS ?? 720,
      loginMaxAttempts: raw.ADMIN_LOGIN_MAX_ATTEMPTS ?? 5,
      loginMaxConcurrent: raw.ADMIN_LOGIN_MAX_CONCURRENT ?? 4,
      loginMaxTrackedIps: raw.ADMIN_LOGIN_MAX_TRACKED_IPS ?? 10_000,
      loginAttemptWindowMinutes: raw.ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES ?? 15,
      loginLockoutMinutes: raw.ADMIN_LOGIN_LOCKOUT_MINUTES ?? 15,
      sessionTouchIntervalSeconds,
      sessionCacheMax: raw.ADMIN_SESSION_CACHE_MAX ?? 1_000,
      sessionRevalidateSeconds: raw.ADMIN_SESSION_REVALIDATE_SECONDS ?? 60,
      sessionCookieInsecure: raw.SESSION_COOKIE_INSECURE ?? false,
      localLoginAllowPublic: raw.ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC ?? false,
    },
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
      maxRequestBodyBytes: raw.MAX_REQUEST_BODY_BYTES ?? 32 * 1024 * 1024,
      maximumJsonDepth: raw.MAX_REQUEST_JSON_DEPTH ?? 256,
    },
    failover: {
      maxAttempts: raw.ROUTING_MAX_ATTEMPTS,
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
    },
  }
}
