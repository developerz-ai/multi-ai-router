import { describe, expect, test } from "bun:test"
import { createLogger, type Logger } from "../../../src/logging/logger"
import { createRuntimeMetrics } from "../../../src/observability"
import { createHealthStore, type RoutingCatalog } from "../../../src/services/dataplane"
import type { UsageStats } from "../../../src/services/usage"

/**
 * The reporting path, seen from outside the process.
 *
 * A usage batch Postgres refuses is the one failure mode that costs nothing at the time and
 * everything afterwards: traffic is served, the client is answered, and the rows describing it are
 * simply not there. It used to move a counter no scrape could read, which made a one-second blip
 * indistinguishable from a healthy hour. These assert that both fates now leave the process —
 * and that they leave it as **separate** series, because a batch that went back for another try is
 * not the same incident as records that no longer exist (docs/idea/08-observability.md#metrics).
 */

const EMPTY: RoutingCatalog = { accounts: () => [], pools: () => [] }
const SILENT: Logger = createLogger({ level: "error", write: () => {} })

const HEALTHY: UsageStats = {
  depth: 0,
  dropped: 0,
  written: 0,
  writeFailures: 0,
  writeDiscarded: 0,
}

/** Scrapes report the recorder's running totals; the counters below are the deltas between them. */
function harness() {
  let stats: UsageStats = HEALTHY
  const metrics = createRuntimeMetrics({
    catalog: EMPTY,
    health: createHealthStore(),
    usage: () => ({ stats: () => stats }),
    logger: SILENT,
  })
  return {
    scrape(totals: Partial<UsageStats> = {}): string {
      stats = { ...HEALTHY, ...totals }
      return metrics.expose()
    },
  }
}

describe("router_usage_write_failures_total", () => {
  test("a router whose writes all landed reports no failure at all, not a fabricated zero", () => {
    const body = harness().scrape({ written: 4_000 })

    expect(body).toContain("# TYPE router_usage_write_failures_total counter")
    expect(body).not.toContain("router_usage_write_failures_total{")
  })

  test("a refused batch reads as retried — reporting is late, nothing is lost", () => {
    const body = harness().scrape({ depth: 200, writeFailures: 200 })

    expect(body).toContain('router_usage_write_failures_total{disposition="retried"} 200')
    expect(body).not.toContain('disposition="discarded"')
  })

  test("records lost after the retry failed are counted apart from the blip before them", () => {
    // The same 200 records, refused twice: the first rejection sent them back, the second binned
    // them. Summing the two dispositions into one alert would page for every blip.
    const body = harness().scrape({ writeFailures: 400, writeDiscarded: 200 })

    expect(body).toContain('router_usage_write_failures_total{disposition="retried"} 200')
    expect(body).toContain('router_usage_write_failures_total{disposition="discarded"} 200')
  })

  test("counts each failure once however often it is scraped", () => {
    // The recorder counts cumulatively and a counter takes increments — a scrape must add only
    // what happened since the last one, or the counter would climb with the scrape interval and
    // an idle minute would read as a failure rate.
    const scrapes = harness()
    scrapes.scrape({ writeFailures: 400, writeDiscarded: 200 })
    scrapes.scrape({ writeFailures: 400, writeDiscarded: 200 })
    const body = scrapes.scrape({ writeFailures: 800, writeDiscarded: 400 })

    expect(body).toContain('router_usage_write_failures_total{disposition="retried"} 400')
    expect(body).toContain('router_usage_write_failures_total{disposition="discarded"} 400')
  })

  test("keeps the queue's own losses on their own counter", () => {
    // Shed on overflow and refused by the database are different failures with different fixes —
    // a bigger queue, versus a database that is up.
    const body = harness().scrape({ depth: 10_000, dropped: 512, writeFailures: 200 })

    expect(body).toContain("router_usage_queue_depth 10000")
    expect(body).toContain("router_usage_records_dropped_total 512")
    expect(body).toContain('router_usage_write_failures_total{disposition="retried"} 200')
  })
})
