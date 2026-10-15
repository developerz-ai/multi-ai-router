import {
  type ApiKeyRepository,
  type ApiKeyTombstoneRepository,
  createUsageHistoryRepository,
  createUsageReportRepository,
  type Database,
  type PoolRepository,
} from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { RoutingCatalogStore } from "../services/catalog"
import { catalogLabels } from "../services/usage-read"
import { createUsageReportService, type UsageReportService } from "../services/usage-report"

/**
 * The weekly report service, wired. Its own module so the admin plane's assembly
 * (`composition/admin.ts`, already past the file cap) does not grow for it.
 *
 * The same instance serves the admin endpoints and the scheduler's task (`generate`), so a preview
 * and a stored report come from one builder and one set of labels.
 */
export function createUsageReports(deps: {
  readonly database: Database
  readonly env: Pick<Env, "usageReport" | "retention" | "failover">
  readonly keys: Pick<ApiKeyRepository, "list">
  readonly keyTombstones: Pick<ApiKeyTombstoneRepository, "listAll">
  readonly pools: Pick<PoolRepository, "list">
  readonly catalog: Pick<RoutingCatalogStore, "accounts" | "pools">
  readonly now: () => Date
}): UsageReportService {
  const { env } = deps
  return createUsageReportService({
    reports: createUsageReportRepository(deps.database),
    history: createUsageHistoryRepository(deps.database),
    labels: catalogLabels({
      keys: deps.keys,
      tombstones: deps.keyTombstones,
      catalog: deps.catalog,
    }),
    // Read live rather than from the warm catalog: the overflow designation is the pool's as it
    // stands at generation time, and a 30 s stale snapshot is not that.
    pools: async () =>
      (await deps.pools.list()).map((pool) => ({
        id: pool.id,
        name: pool.name,
        overflowAccountId: pool.overflowAccountId,
      })),
    settleMinutes: env.usageReport.settleMinutes,
    upstreamTimeoutMs: env.failover.upstreamTimeoutMs,
    // One row a week, plus two for a week in flight and a clock edge.
    listLimit: Math.ceil(env.retention.usageReportsDays / 7) + 2,
    now: deps.now,
  })
}
