import { describe, expect, test } from "bun:test"
import { createLogger, type Logger } from "../../../src/logging/logger"
import { createRuntimeMetrics, type RuntimeMetricsDeps } from "../../../src/observability"
import { createSdkConcurrency, type SdkConcurrency } from "../../../src/providers"
import { createHealthStore, type RoutingCatalog } from "../../../src/services/dataplane"

/**
 * The `claude` subprocess ceiling, seen from outside the process.
 *
 * `CLAUDE_SDK_MAX_CONCURRENCY` is a **memory** bound, so the two questions an operator has to be
 * able to answer are "how much of it is in use" and "is anyone waiting" — the second is what says
 * whether the ceiling is too low or the replica count is
 * (docs/idea/11-anthropic-agent-sdk.md §9, docs/idea/09-deployment.md#sizing).
 *
 * Sampled per scrape from the gate's own counters rather than mirrored on every acquire: the path
 * being bounded is a request path, and a metric write on it would be bookkeeping nobody reads until
 * Prometheus asks.
 */

/** An empty deployment: the gauges under test read the gate, never the account inventory. */
const EMPTY: RoutingCatalog = { accounts: () => [], pools: () => [] }
const SILENT: Logger = createLogger({ level: "error", write: () => {} })

function harness(sdkConcurrency?: SdkConcurrency) {
  const deps: RuntimeMetricsDeps = {
    catalog: EMPTY,
    health: createHealthStore(),
    usage: () => ({
      stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
    }),
    ...(sdkConcurrency === undefined ? {} : { sdkConcurrency }),
    logger: SILENT,
  }
  return createRuntimeMetrics(deps)
}

describe("the claude subprocess gauges", () => {
  test("report an idle replica as zero held and zero waiting", () => {
    const body = harness(createSdkConcurrency({ global: 4, perAccount: 2 })).expose()

    expect(body).toContain("router_sdk_subprocesses 0")
    expect(body).toContain("router_sdk_subprocess_queue_depth 0")
  })

  test("report occupancy and the queue behind it, read at scrape time", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const metrics = harness(concurrency)

    const held = await concurrency.acquire("acc-1", new AbortController().signal)
    // A second Account, so only the global gate can be what queues it.
    const queued = concurrency.acquire("acc-2", new AbortController().signal)
    await Promise.resolve()

    const saturated = metrics.expose()
    expect(saturated).toContain("router_sdk_subprocesses 1")
    expect(saturated).toContain("router_sdk_subprocess_queue_depth 1")

    held.release()
    ;(await queued).release()

    // The next scrape reads the gate again rather than a remembered high-water mark.
    const drained = metrics.expose()
    expect(drained).toContain("router_sdk_subprocesses 0")
    expect(drained).toContain("router_sdk_subprocess_queue_depth 0")
  })

  test("report no sample at all when no gate is wired, rather than an idle ceiling", () => {
    const body = harness().expose()

    // The families are still declared — that is the exposition format, and a scraper reading HELP
    // for a metric with no series is reading the truth. What must not appear is a *value*: a
    // `router_sdk_subprocesses 0` from a build that cannot spawn one is an assertion, not a reading.
    expect(body).toContain("# TYPE router_sdk_subprocesses gauge")
    expect(body).not.toContain("\nrouter_sdk_subprocesses ")
    expect(body).not.toContain("\nrouter_sdk_subprocess_queue_depth ")
  })
})
