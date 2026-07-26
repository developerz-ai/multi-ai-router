import { describe, expect, test } from "bun:test"
import { OVERHEAD_METRIC, render, verdict } from "../../bench/report"
import { parseArgs } from "../../bench/run"
import { type DriveOptions, runScenario, SCENARIOS } from "../../bench/scenarios"

/**
 * Keeps `bin/bench` honest. A benchmark nobody runs rots, and one that rots silently is worse than
 * none — it reports PASS because it measured nothing.
 *
 * So this drives the real harness at a size that fits in a test run and asserts the things that are
 * true regardless of how loaded the machine is: every scenario answered, every request landed a
 * sample on the histogram, and the two egress paths under test really are two different paths.
 *
 * **What it does not assert is the 5 ms number.** A timing threshold on a shared CI runner is a
 * flaky test, and a flaky gate teaches people to skip it. The budget is enforced by `bin/bench`'s
 * exit code, run deliberately. The one timing claim asserted here is buffering, and only because
 * its margin is a whole stream wide rather than a millisecond: a relay that accumulated would
 * deliver its first byte after the upstream's last, not a few microseconds late.
 */

/** Small and quick: enough samples to prove the wiring, few enough to belong in `bin/test`. */
const OPTIONS: DriveOptions = {
  requests: 12,
  concurrency: 4,
  warmup: 2,
  promptBytes: 256,
  chunks: 8,
  chunkGapMs: 2,
  firstByteDelayMs: 2,
}

describe("the overhead bench", () => {
  test("drives every scenario against the stub upstream and records a sample for each request", async () => {
    const results = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario, OPTIONS)))
    const outcome = verdict(results, Number.POSITIVE_INFINITY)

    expect(outcome.rows).toHaveLength(SCENARIOS.length)
    for (const row of outcome.rows) {
      expect(row.failures).toBe(0)
      // One `UsageRecord` per request, and every one of them reached the histogram.
      expect(row.samples).toBe(OPTIONS.requests)
      expect(row.overheadP99Ms).not.toBeNaN()
      expect(row.overheadMeanMs).toBeGreaterThanOrEqual(0)
    }
    expect(outcome.violations).toEqual([])
  }, 30_000)

  test("covers both non-SDK egress paths — the labels prove it was not passthrough twice", async () => {
    const results = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario, OPTIONS)))

    for (const result of results) {
      expect(result.exposition).toContain(`path="${result.scenario.path}"`)
    }
    expect(new Set(results.map((result) => result.scenario.path))).toEqual(
      new Set(["passthrough", "translate"]),
    )
  }, 30_000)

  test("no stream is buffered: the client's first byte beats the upstream's last on every path", async () => {
    const streamed = SCENARIOS.filter((scenario) => scenario.stream)
    const results = await Promise.all(streamed.map((scenario) => runScenario(scenario, OPTIONS)))

    expect(streamed).not.toHaveLength(0)
    for (const result of results) {
      expect(result.buffered).toBe(0)
      expect(result.addedTtftMs).toHaveLength(OPTIONS.requests)
    }
  }, 30_000)

  test("renders a report naming the metric it read and the verdict it reached", async () => {
    const results = [await runScenario(SCENARIOS[0] ?? notReached(), OPTIONS)]

    expect(render(verdict(results, Number.POSITIVE_INFINITY))).toContain(OVERHEAD_METRIC)
    expect(render(verdict(results, Number.POSITIVE_INFINITY))).toContain("PASS")
    // A budget nothing can meet fails, and the failure names the scenario rather than a number.
    expect(render(verdict(results, 0))).toContain("FAIL")
  }, 30_000)
})

describe("the verdict", () => {
  /**
   * The failure branches, driven by hand. A run against the real relay never buffers — which is the
   * point of the relay, and also why the detector would otherwise ship untested.
   */
  const scenario = SCENARIOS[0] ?? notReached()
  const exposition = [
    'router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="0.0005"} 8',
    'router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="+Inf"} 10',
    'router_overhead_seconds_sum{ingress_dialect="anthropic",path="passthrough"} 0.02',
    'router_overhead_seconds_count{ingress_dialect="anthropic",path="passthrough"} 10',
  ].join("\n")

  test("names a buffered relay rather than letting it read as a slow percentile", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 0, exposition, addedTtftMs: [], buffered: 3 }],
      5,
    )

    expect(outcome.violations).toHaveLength(1)
    expect(outcome.violations[0]).toContain("3 streams")
    expect(outcome.violations[0]).toContain("the relay buffered")
    expect(render(outcome)).toContain("FAIL")
  })

  test("refuses to pass a run whose requests failed, however fast they failed", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 2, exposition, addedTtftMs: [], buffered: 0 }],
      5,
    )

    expect(outcome.violations[0]).toContain("2 of 10 requests failed")
  })

  test("a scenario that recorded nothing fails — an empty series is not a fast one", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 0, exposition: "", addedTtftMs: [], buffered: 0 }],
      5,
    )

    expect(outcome.violations[0]).toContain("recorded no samples")
    expect(render(outcome)).toContain("—")
  })
})

describe("bin/bench arguments", () => {
  test("defaults are complete, so an argument-free run is a valid run", () => {
    const options = parseArgs([])

    expect(options.requests).toBeGreaterThan(0)
    expect(options.concurrency).toBeGreaterThan(0)
    expect(options.budgetMs).toBe(5)
    expect(options.json).toBe(false)
  })

  test("takes each knob by name", () => {
    const options = parseArgs(["--requests", "10", "--budget-ms", "2", "--json"])

    expect(options.requests).toBe(10)
    expect(options.budgetMs).toBe(2)
    expect(options.json).toBe(true)
  })

  test("refuses an unknown option and a non-numeric one rather than benching the wrong thing", () => {
    expect(() => parseArgs(["--nope"])).toThrow("unknown option --nope")
    expect(() => parseArgs(["--requests", "lots"])).toThrow("--requests needs a number")
  })
})

function notReached(): never {
  throw new Error("SCENARIOS must not be empty")
}
