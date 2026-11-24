import { UNKNOWN_REVISION } from "@multi-ai-router/core"
import { DATABASE_POOL_DEFAULTS } from "@multi-ai-router/db"
import { z } from "zod"
import { CLI_REFRESH_LEAD_MS } from "../providers/claude-sdk/credential-freshness"
import { worstCaseTickMs } from "../services/routing/exhausted-retest"
import { readAdminBodiesEnv } from "./admin-bodies"
import { readBackgroundEnv } from "./background"
import { readClaudeLoginEnv } from "./claude-login"
import { readClaudeSdkPacingEnv } from "./claude-sdk-pacing"
import { readCliOwnershipEnv } from "./cli-ownership"
import { readEgressProxyEnv } from "./egress-proxy"
import {
  DEFAULT_LOG_QUIET_PATHS,
  DEFAULT_SCHEDULER_JITTER_FRACTION,
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
} from "./env-defaults"
import { readAdminOidcEnv } from "./env-oidc"
import type { ParsedEnv } from "./env-schema"
import type { Env } from "./env-types"
import { readMetricInventoryEnv } from "./metric-inventory"
import { readRecoveryEnv } from "./recovery"
import { readRelayLifetimesEnv } from "./relay-lifetimes"
import { readRetentionEnv } from "./retention"
import { readRoutingEnv } from "./routing-env"
import { readRuntimeLimitsEnv } from "./runtime-limits"
import { readUpstreamStreamEnv } from "./upstream-stream"
import { readUsageReadEnv } from "./usage-read"
import { readUsageReportEnv } from "./usage-report"

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

  // An hour, then doubling to a day: a drained balance costs one failed probe a day, a misread wall
  // is back within the hour (rule 7, amended: developerz.ai#7868). The doubling stops one
  // `COOLDOWN_RECHECK_INTERVAL_MINUTES` timer-and-two-runs span (jitter included) short of the cap —
  // a
  // re-test can be early in one task and late in its successor, so the wait leaves room for the
  // timer plus both bounded task runs.
  const exhaustedRecheckFirstMinutes = raw.EXHAUSTED_RECHECK_FIRST_MINUTES ?? 60
  const exhaustedRecheckMaxMinutes = raw.EXHAUSTED_RECHECK_MAX_MINUTES ?? 1_440
  const cooldownRecheckIntervalMinutes = raw.COOLDOWN_RECHECK_INTERVAL_MINUTES ?? 60
  const schedulerJitterFraction = raw.SCHEDULER_JITTER_FRACTION ?? DEFAULT_SCHEDULER_JITTER_FRACTION
  const taskMaxRunMinutes = raw.SCHEDULER_TASK_MAX_RUN_MINUTES ?? 60
  const exhaustedRetestTickMs = worstCaseTickMs(
    cooldownRecheckIntervalMinutes * 60_000,
    schedulerJitterFraction,
    taskMaxRunMinutes * 60_000,
  )
  if (
    exhaustedRecheckFirstMinutes * 60_000 + exhaustedRetestTickMs >
    exhaustedRecheckMaxMinutes * 60_000
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["EXHAUSTED_RECHECK_MAX_MINUTES"],
      message:
        `must be at least EXHAUSTED_RECHECK_FIRST_MINUTES (${exhaustedRecheckFirstMinutes}) plus ` +
        `the worst-case cooldown recheck span (${exhaustedRetestTickMs / 60_000} minutes): an ` +
        `early re-test and late successor need that timer and both bounded task runs`,
    })
    return z.NEVER
  }

  const claudeLogin = readClaudeLoginEnv(raw, ctx)
  if (claudeLogin === undefined) return z.NEVER

  const usageReport = readUsageReportEnv(raw, ctx)
  if (usageReport === undefined) return z.NEVER

  const serverIdleTimeoutSeconds =
    raw.SERVER_IDLE_TIMEOUT_SECONDS ?? DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS
  const pacing = readClaudeSdkPacingEnv({ ...raw, serverIdleTimeoutSeconds }, ctx)
  if (pacing === undefined) return z.NEVER

  return {
    ...claudeLogin,
    usageReport: usageReport.usageReport,
    ...readEgressProxyEnv(raw),
    ...readRecoveryEnv(raw),
    ...readUsageReadEnv(raw),
    ...readAdminBodiesEnv(raw),
    ...readBackgroundEnv(raw),
    ...readRelayLifetimesEnv(raw),
    ...readUpstreamStreamEnv(raw, ctx),
    ...readMetricInventoryEnv(raw),
    ...readCliOwnershipEnv(raw),
    ...pacing,
    ...readRuntimeLimitsEnv(raw),
    port: raw.PORT ?? 8080,
    serverIdleTimeoutSeconds,
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
      statementTimeoutMs: raw.DB_STATEMENT_TIMEOUT_MS ?? DATABASE_POOL_DEFAULTS.statementTimeoutMs,
      lockTimeoutMs: raw.DB_LOCK_TIMEOUT_MS ?? DATABASE_POOL_DEFAULTS.lockTimeoutMs,
      idleInTransactionTimeoutMs:
        raw.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? DATABASE_POOL_DEFAULTS.idleInTransactionTimeoutMs,
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
    poolRosterPath: raw.POOL_ROSTER_PATH ?? null,
    poolRosterCheckIntervalMinutes: raw.POOL_ROSTER_CHECK_INTERVAL_MINUTES ?? 15,
    poolRoster: null,
    claudeConfigRoot: raw.CLAUDE_CONFIG_ROOT ?? "/data/claude",
    claudeCliPath: raw.CLAUDE_CLI_PATH ?? null,
    claudeFastMode: raw.CLAUDE_FAST_MODE ?? true,
    claudeSdkMaxConcurrency: raw.CLAUDE_SDK_MAX_CONCURRENCY ?? 10,
    claudeSdkMaxConcurrencyPerAccount: raw.CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT ?? 4,
    // A Claude request waits at the subprocess gate for at most this long in total, then moves on to
    // the next account. 60 s clears an ordinary burst (the p90 Claude call is 38 s) and stays under
    // the 300 s idle cut every client applies to a silent call.
    claudeSdkQueueWaitMs: raw.CLAUDE_SDK_QUEUE_WAIT_MS ?? 60_000,
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
    retention: readRetentionEnv(raw, {
      usageDays,
      usageDailyDays,
      usageReportsDays: usageReport.usageReportsDays,
    }),
    janitorIntervalMinutes: raw.JANITOR_INTERVAL_MINUTES ?? 60,
    scheduler: {
      lockPoolMaxConnections: raw.SCHEDULER_LOCK_POOL_MAX_CONNECTIONS ?? 1,
      localCapacityRetryMs: raw.SCHEDULER_LOCAL_CAPACITY_RETRY_MS ?? 1_000,
      usageRollupIntervalMinutes: raw.USAGE_ROLLUP_INTERVAL_MINUTES ?? 60,
      usageReportIntervalMinutes: usageReport.usageReportIntervalMinutes,
      oauthStatePurgeIntervalMinutes: raw.OAUTH_STATE_PURGE_INTERVAL_MINUTES ?? 5,
      quotaFloorIntervalMinutes: raw.QUOTA_FLOOR_INTERVAL_MINUTES ?? 30,
      cooldownRecheckIntervalMinutes,
      exhaustedRecheckFirstMinutes,
      exhaustedRecheckMaxMinutes,
      // A quarter hour: a five-hour window moves little in that, and each read is one free GET.
      planQuotaReadIntervalMinutes: raw.PLAN_QUOTA_READ_INTERVAL_MINUTES ?? 15,
      planQuotaReadBatchSize: raw.PLAN_QUOTA_READ_BATCH_SIZE ?? 25,
      // Hours, not minutes: an orphan is a crash artifact, so a router that never crashes sweeps
      // an empty root forever and one that did leaves a directory nobody is racing to reclaim.
      configDirReapIntervalMinutes: raw.CONFIG_DIR_REAP_INTERVAL_MINUTES ?? 360,
      // Hourly, like the janitor it mirrors: a transcript becomes removable once an hour at the
      // most, and a sweep is a directory walk over a few thousand names, not a subprocess.
      sdkTranscriptSweepIntervalMinutes: raw.SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES ?? 60,
      // Hourly against a window of days: a reap lands at most an hour past its due instant.
      poolReapIntervalMinutes: raw.POOL_REAP_INTERVAL_MINUTES ?? 60,
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
      jitterFraction: schedulerJitterFraction,
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
    ...readRoutingEnv(raw),
  }
}
