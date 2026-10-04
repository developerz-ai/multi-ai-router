import { createAdminSessionRepository } from "@multi-ai-router/db"
import { createRuntimeMetrics } from "../observability"
import { createSdkUsageGauge } from "../providers"
import { createPostgresSessionStore } from "../services/admin-auth"
import { gaugeObservationCapture } from "../services/dataplane/gauge-observation"
import { createUsageRecorderFromEnv, type UsageRecorder } from "../services/usage"
import type { createCliResources } from "./cli-resources"
import type { createRuntimeRepositories } from "./runtime-repositories"
import type { RuntimeDeps } from "./runtime-types"
import type { createWarmState } from "./warm-state"
export function createRuntimeTelemetry(
  deps: RuntimeDeps,
  repositories: ReturnType<typeof createRuntimeRepositories>,
  warm: ReturnType<typeof createWarmState>,
  cli: ReturnType<typeof createCliResources>,
  now: () => Date,
) {
  const { env, database, logger } = deps
  const { accounts, usageRecords, refreshLock, schedulerLock } = repositories
  const { recoveryComponents, health, prices, catalog, sdkQuota } = warm
  const { sdkConcurrency } = cli
  // `usage` is a getter because the recorder below reports *into* this: see `observability/`.
  const metrics = createRuntimeMetrics({
    metricInventory: env.metricInventory,
    catalog: recoveryComponents.access.catalog,
    health,
    usage: () => usage,
    sdkConcurrency,
    dbPool: {
      sample: () => {
        const main = deps.dbPoolStats()
        const auxiliary = refreshLock.poolStats()
        const scheduled = schedulerLock.poolStats()
        return {
          inUse: main.inUse + auxiliary.inUse + scheduled.inUse,
          idle: main.idle + auxiliary.idle + scheduled.idle,
          waiting: main.waiting + auxiliary.waiting + scheduled.waiting,
          max: main.max + auxiliary.max + scheduled.max,
        }
      },
    },
    prices,
    logger,
    now,
    revision: env.revision,
  })

  // Queued in memory, batch-written off-path. Both loss modes reach a log line — see fromEnv.ts.
  const usage: UsageRecorder = createUsageRecorderFromEnv({
    records: usageRecords,
    // Stamped on the same background drain the records are written on, so the idle probe can
    // find an account nothing has routed to without scanning `usage_records`.
    accounts,
    env,
    logger,
    onRecord: (record) => metrics.observeUsage(record),
    onAdmissionDuration: (milliseconds) => metrics.observeUsageAdmission(milliseconds),
  })

  // The admin console's session state, in Postgres: a redeploy or a crash no longer logs the
  // operator out (`services/admin-auth/postgresSessionStore.ts`). Built here, once, so the
  // scheduler's session-purge task and the admin plane's auth service share the one cache in front
  // of the one table.
  const adminSessions = createPostgresSessionStore({
    repository: createAdminSessionRepository(database),
    logger,
    cacheMaxEntries: env.adminAuth.sessionCacheMax,
    revalidateAfterMs: env.adminAuth.sessionRevalidateSeconds * 1_000,
  })

  // The continuous half of a subscription's quota picture (`providers/claude-sdk/usage-gauge.ts`):
  // a reading is folded into the same per-Account buckets a `rate_limit_event` fills and then
  // applied to the health store through the same fold — which is what makes it durable
  // (`onQuotaWindows` above) and visible to the console. Never a verdict: `ingestGauge`'s signal
  // is never `limited`, so this can only ever record windows.
  const usageGauge = createSdkUsageGauge({
    enabled: env.claudeSdkUsageGauge.enabled,
    timeoutMs: env.claudeSdkUsageGauge.timeoutMs,
    minIntervalMs: env.claudeSdkUsageGauge.minIntervalSeconds * 1_000,
    logger,
    now,
    capture: gaugeObservationCapture(catalog, health, sdkQuota),
  })

  return { metrics, usage, adminSessions, usageGauge }
}
