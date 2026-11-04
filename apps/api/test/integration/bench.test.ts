import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Budgets, OVERHEAD_METRIC, render, verdict } from "../../bench/report"
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
 * **What it does not assert is the 5 ms number, or the TTFT ceiling.** A timing threshold on a
 * shared CI runner is a flaky test, and a flaky gate teaches people to skip it. The budget is
 * enforced by `bin/bench`'s exit code, run deliberately. What *is* asserted here is that both
 * ceilings exist and bite, driven with hand-built rows rather than the clock — a gate that only
 * fires on a real regression is a gate nobody can prove works. The one timing claim asserted
 * against the live relay is buffering, and only because its margin is a whole stream wide rather
 * than a millisecond: a relay that accumulated would deliver its first byte after the upstream's
 * last, not a few microseconds late.
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

/** Wide enough that a loaded machine never trips it — this file tests wiring, not timing. */
const UNBOUNDED: Budgets = {
  overheadP99Ms: Number.POSITIVE_INFINITY,
  addedTtftP95Ms: Number.POSITIVE_INFINITY,
}

describe("the overhead bench", () => {
  test("drives every scenario against the stub upstream and records a sample for each request", async () => {
    const results = await Promise.all(SCENARIOS.map((scenario) => runScenario(scenario, OPTIONS)))
    const outcome = verdict(results, UNBOUNDED)

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

    expect(render(verdict(results, UNBOUNDED))).toContain(OVERHEAD_METRIC)
    expect(render(verdict(results, UNBOUNDED))).toContain("PASS")
    // A budget nothing can meet fails, and the failure names the scenario rather than a number.
    expect(render(verdict(results, { ...UNBOUNDED, overheadP99Ms: 0 }))).toContain("FAIL")
  }, 30_000)
})

describe("the verdict", () => {
  /**
   * The failure branches, driven by hand. A run against the real relay never buffers — which is the
   * point of the relay, and also why the detector would otherwise ship untested.
   */
  const scenario = SCENARIOS[0] ?? notReached()
  const streamed = SCENARIOS.find((candidate) => candidate.stream) ?? notReached()
  const BUDGETS: Budgets = { overheadP99Ms: 5, addedTtftP95Ms: 2 }
  const exposition = [
    'router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="0.0005"} 8',
    'router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="+Inf"} 10',
    'router_overhead_seconds_sum{ingress_dialect="anthropic",path="passthrough"} 0.02',
    'router_overhead_seconds_count{ingress_dialect="anthropic",path="passthrough"} 10',
  ].join("\n")

  /** `sampleQuantile` reads its input as already sorted, which is what `runScenario` hands it. */
  const ascending = (count: number, value: number, tail: number, tailValue: number): number[] => [
    ...Array.from({ length: count }, () => value),
    ...Array.from({ length: tail }, () => tailValue),
  ]

  test("names a buffered relay rather than letting it read as a slow percentile", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 0, exposition, addedTtftMs: [], buffered: 3 }],
      BUDGETS,
    )

    expect(outcome.violations).toHaveLength(1)
    expect(outcome.violations[0]).toContain("3 streams")
    expect(outcome.violations[0]).toContain("the relay buffered")
    expect(render(outcome)).toContain("FAIL")
  })

  test("refuses to pass a run whose requests failed, however fast they failed", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 2, exposition, addedTtftMs: [], buffered: 0 }],
      BUDGETS,
    )

    expect(outcome.violations[0]).toContain("2 of 10 requests failed")
  })

  test("a scenario that recorded nothing fails — an empty series is not a fast one", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 0, exposition: "", addedTtftMs: [], buffered: 0 }],
      BUDGETS,
    )

    expect(outcome.violations[0]).toContain("recorded no samples")
    expect(render(outcome)).toContain("—")
  })

  /**
   * The half of non-negotiable 8 that `buffered` alone cannot see. A relay that adds latency to
   * every first byte but still beats the upstream's *last* byte buffers nothing — at these defaults
   * the stream is `chunks * chunk-gap-ms` wide, and in production it is seconds wide. Without a
   * ceiling on the measured number, that whole window reads as PASS.
   */
  test("fails a stream whose added time-to-first-token is over the ceiling, though it never buffered", () => {
    const outcome = verdict(
      [
        {
          scenario: streamed,
          requests: 10,
          failures: 0,
          exposition,
          addedTtftMs: ascending(10, 15, 0, 15),
          buffered: 0,
        },
      ],
      BUDGETS,
    )

    expect(outcome.violations).toHaveLength(1)
    expect(outcome.violations[0]).toContain("added time-to-first-token p95")
    expect(outcome.violations[0]).toContain("2 ms ceiling")
    expect(render(outcome)).toContain("OVER")
  })

  /**
   * Pins the p95-not-p99 choice. The added-TTFT p99 is a scheduler artifact — measured moving
   * 0.56 → 4.03 ms across four consecutive runs of identical code — so gating it would fail runs
   * for being unlucky. p95 catches every systematic regression, which is all of them.
   */
  test("passes a stream that is only late in its tail — the noisy quantile is not the gated one", () => {
    const outcome = verdict(
      [
        {
          scenario: streamed,
          requests: 200,
          failures: 0,
          exposition,
          addedTtftMs: ascending(197, 0.1, 3, 50),
          buffered: 0,
        },
      ],
      BUDGETS,
    )

    expect(outcome.rows[0]?.addedTtftP95Ms).toBeLessThan(BUDGETS.addedTtftP95Ms)
    expect(outcome.rows[0]?.addedTtftP99Ms).toBeGreaterThan(BUDGETS.addedTtftP95Ms)
    expect(outcome.violations).toEqual([])
  })

  test("a streamed scenario that timed no first byte fails rather than reporting a blank as a pass", () => {
    const outcome = verdict(
      [{ scenario: streamed, requests: 10, failures: 0, exposition, addedTtftMs: [], buffered: 0 }],
      BUDGETS,
    )

    expect(outcome.violations[0]).toContain("no time-to-first-token was measured")
  })

  test("holds a non-streamed scenario to the overhead budget only — it has no first token to be late with", () => {
    const outcome = verdict(
      [{ scenario, requests: 10, failures: 0, exposition, addedTtftMs: [], buffered: 0 }],
      { overheadP99Ms: 5, addedTtftP95Ms: 0 },
    )

    expect(outcome.violations).toEqual([])
  })
})

describe("bin/bench arguments", () => {
  test("defaults are complete, so an argument-free run is a valid run", () => {
    const options = parseArgs([])

    expect(options.requests).toBeGreaterThan(0)
    expect(options.concurrency).toBeGreaterThan(0)
    expect(options.budgetMs).toBe(5)
    // Both halves of the budget carry a default, or the second one is opt-in and so never enforced.
    expect(options.ttftBudgetMs).toBeGreaterThan(0)
    expect(options.json).toBe(false)
  })

  test("takes each knob by name", () => {
    const options = parseArgs([
      "--requests",
      "10",
      "--budget-ms",
      "2",
      "--ttft-budget-ms",
      "0.5",
      "--json",
    ])

    expect(options.requests).toBe(10)
    expect(options.budgetMs).toBe(2)
    expect(options.ttftBudgetMs).toBe(0.5)
    expect(options.json).toBe(true)
  })

  test("refuses an unknown option and a non-numeric one rather than benching the wrong thing", () => {
    expect(() => parseArgs(["--nope"])).toThrow("unknown option --nope")
    expect(() => parseArgs(["--requests", "lots"])).toThrow("--requests needs a number")
  })
})

describe("the bin/bench runtime guard", () => {
  /**
   * A budget measured on a Bun the suite and the released image never ran on is not a budget for
   * this code — it is a number for a different runtime. So `bin/bench` asks the repository's own
   * runtime contract (`bin/lib/require-bun`) before the harness starts, and refuses on a mismatch.
   *
   * The guard is proved here by shadowing `bun` with a shim: `--version` answers with a fixture
   * version, and any other argv is recorded to a marker file instead of running the harness. The
   * marker is therefore the evidence of whether the benchmark started at all — without it, "exited
   * non-zero" would be indistinguishable from "the harness ran and failed".
   *
   * The shim is PREPENDED to PATH, not substituted for it: `bin/bench` calls `dirname` externally
   * while locating the repository root, so a PATH of only the fixture directory would break the
   * wrapper before the guard was ever reached.
   */
  const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
  const PINNED_BUN = readFileSync(`${ROOT}.bun-version`, "utf8").trim()

  /**
   * A `bun` that reports the fixture version for `--version` and, for anything else, records its
   * argv to the marker file and exits the fixture code without running the harness.
   */
  function fakeBun(dir: string): void {
    writeFileSync(
      join(dir, "bun"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  printf '%s\\n' \"$FIXTURE_BUN_VERSION\"",
        "  exit 0",
        "fi",
        'printf "%s\\n" "$*" >> "$FIXTURE_BUN_MARKER"',
        'exit "$FIXTURE_BUN_EXIT"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
  }

  /**
   * Runs the real `bin/bench` with the shim first on PATH.
   *
   * @returns the spawn result plus the argv the shim recorded — empty when the harness never ran,
   *   which is the evidence that the guard rejected the run before any measurement.
   */
  function runBench(
    version: string,
    exitCode: number,
    args: string[] = [],
  ): { status: number | null; stderr: string; invoked: string } {
    const dir = mkdtempSync(join(tmpdir(), "router-bench-guard-"))
    try {
      const marker = join(dir, "invoked.txt")
      fakeBun(dir)
      const result = spawnSync(`${ROOT}bin/bench`, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FIXTURE_BUN_VERSION: version,
          FIXTURE_BUN_MARKER: marker,
          FIXTURE_BUN_EXIT: String(exitCode),
        },
        encoding: "utf8",
      })
      expect(result.error).toBeUndefined()
      return {
        status: result.status,
        stderr: result.stderr,
        // Read before the fixture directory is swept — the marker is the whole evidence.
        invoked: existsSync(marker) ? readFileSync(marker, "utf8").trim() : "",
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("refuses to measure on a Bun the repository does not pin, and the harness never starts", () => {
    const wrong = "0.0.0"

    const run = runBench(wrong, 0)

    expect(run.status).toBe(1)
    // The message names what is wanted and where it is pinned, so the reader can fix it.
    expect(run.stderr).toContain(`Bun ${PINNED_BUN} is required`)
    expect(run.stderr).toContain(".bun-version")
    // The whole point: no measurement was taken on the rejected runtime.
    expect(run.invoked).toBe("")
  })

  test("runs the harness on the pinned Bun and passes every argument through unchanged", () => {
    const run = runBench(PINNED_BUN, 0, ["--requests", "7", "--json"])

    // The harness path and the arguments reach it exactly as they were given.
    expect(run.invoked).toBe("apps/api/bench/run.ts --requests 7 --json")
  })

  test("returns the harness's own exit code, so a budget breach still fails the run", () => {
    // The shim stands in for the harness and fails the way a budget breach does.
    const run = runBench(PINNED_BUN, 1)

    expect(run.invoked).toBe("apps/api/bench/run.ts")
    expect(run.status).toBe(1)
  })

  /**
   * Runs the repository's own `bin/bench` against a tree where `bin/lib/require-bun` is replaced by
   * a recorder, so the CALL is observable rather than merely its effect.
   *
   * The other assertions in this block cannot tell the shared contract apart from a copy of it: a
   * `bin/bench` that compared `bun --version` to `.bun-version` itself would refuse the same run,
   * print the same message and never start the harness — every one of those assertions would still
   * pass. Only the call itself distinguishes them, and the criterion is about the call: the runtime
   * contract is one script, reused, not re-derived per caller.
   *
   * The tree mirrors the layout `bin/bench` depends on — it `cd`s to its own parent and then calls
   * `bin/lib/require-bun` relative to it — so the recorder is reached exactly as the real helper is.
   */
  function runAgainstRecorder(): { recorderCalls: number; invoked: string } {
    const dir = mkdtempSync(join(tmpdir(), "router-bench-contract-"))
    try {
      const recorder = join(dir, "contract.txt")
      const marker = join(dir, "invoked.txt")
      // The real wrapper, verbatim — a hand-written copy of it could drift from the shipped one
      // and quietly test a script nobody runs.
      mkdirSync(join(dir, "bin", "lib"), { recursive: true })
      copyFileSync(`${ROOT}bin/bench`, join(dir, "bin", "bench"))
      copyFileSync(`${ROOT}.bun-version`, join(dir, ".bun-version"))
      // The recorder stands in for the shared contract: it records that it was called and lets the
      // run proceed, so the harness still starts and the run still measures something.
      writeFileSync(
        join(dir, "bin", "lib", "require-bun"),
        ["#!/bin/sh", 'printf "called\\n" >> "$FIXTURE_CONTRACT_MARKER"', "exit 0", ""].join("\n"),
        { mode: 0o755 },
      )
      fakeBun(dir)
      const result = spawnSync(join(dir, "bin", "bench"), ["--requests", "7", "--json"], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FIXTURE_BUN_VERSION: PINNED_BUN,
          FIXTURE_BUN_MARKER: marker,
          FIXTURE_BUN_EXIT: "0",
          FIXTURE_CONTRACT_MARKER: recorder,
        },
        encoding: "utf8",
      })
      expect(result.error).toBeUndefined()
      return {
        recorderCalls: existsSync(recorder)
          ? readFileSync(recorder, "utf8").trim().split("\n").length
          : 0,
        invoked: existsSync(marker) ? readFileSync(marker, "utf8").trim() : "",
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("asks the repository's runtime contract, rather than a copy of it inside the wrapper", () => {
    const run = runAgainstRecorder()

    // The shared contract was consulted — a bench-local version check never reaches it.
    expect(run.recorderCalls).toBe(1)
    // And the benchmark still ran, so the guard did not simply refuse everything.
    expect(run.invoked).toBe("apps/api/bench/run.ts --requests 7 --json")
  })
})

function notReached(): never {
  throw new Error("SCENARIOS must not be empty")
}
