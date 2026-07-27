import { describe, expect, test } from "bun:test"
import { createLogger, type Logger } from "../../../src/logging/logger"
import { createRuntimeMetrics, type RuntimeMetricsDeps } from "../../../src/observability"
import { createHealthStore, type RoutingCatalog } from "../../../src/services/dataplane"

/**
 * `router_db_pool_connections`, read from the pool wrapper's own sample
 * (`packages/db/src/pool-metrics.ts`) once per scrape — the same "read warm state when Prometheus
 * asks" shape as the `claude` subprocess gauges beside it.
 */

const EMPTY: RoutingCatalog = { accounts: () => [], pools: () => [] }
const SILENT: Logger = createLogger({ level: "error", write: () => {} })

function harness(dbPool?: RuntimeMetricsDeps["dbPool"]) {
  return createRuntimeMetrics({
    catalog: EMPTY,
    health: createHealthStore(),
    usage: () => ({
      stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
    }),
    ...(dbPool === undefined ? {} : { dbPool }),
    logger: SILENT,
  })
}

describe("router_db_pool_connections", () => {
  test("reports the wrapper's sample, by state", () => {
    const body = harness({ sample: () => ({ inUse: 2, idle: 8, waiting: 0 }) }).expose()

    expect(body).toContain('router_db_pool_connections{state="in_use"} 2')
    expect(body).toContain('router_db_pool_connections{state="idle"} 8')
    expect(body).toContain('router_db_pool_connections{state="waiting"} 0')
  })

  test("reads the sample again on the next scrape, not a remembered one", () => {
    let sample = { inUse: 10, idle: 0, waiting: 3 }
    const metrics = harness({ sample: () => sample })
    expect(metrics.expose()).toContain('router_db_pool_connections{state="waiting"} 3')

    sample = { inUse: 0, idle: 10, waiting: 0 }
    expect(metrics.expose()).toContain('router_db_pool_connections{state="waiting"} 0')
  })

  test("reports no sample at all when no pool is wired, rather than a fabricated zero", () => {
    const body = harness().expose()

    expect(body).toContain("# TYPE router_db_pool_connections gauge")
    expect(body).not.toContain("router_db_pool_connections{")
  })
})
