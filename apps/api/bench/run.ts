import { render, verdict } from "./report"
import { type DriveOptions, runScenario, SCENARIOS, type ScenarioResult } from "./scenarios"

/**
 * `bin/bench` — the overhead budget, measured instead of asserted.
 *
 * CLAUDE.md non-negotiable 8 calls a regression in `router_overhead_seconds` a bug. A number nobody
 * can reproduce on demand is not a budget, so this drives the real router against an in-process stub
 * upstream, scrapes its own `/metrics`, and exits non-zero when the p99 is over budget or a stream
 * came back buffered. That makes it usable as a gate; it is deliberately *not* part of `bin/check`,
 * because a timing measurement on a shared CI runner is a flaky test, and a flaky gate is a gate
 * people learn to ignore.
 *
 * Scope: both non-SDK egress paths, streamed and not. The Agent-SDK path spawns a subprocess per
 * request and is the budget's labeled exception — benching it here would report the subprocess.
 */

/**
 * Concurrency and the stub's think time are a pair, and both are load-shaping rather than taste.
 * The router is one event loop: offered load is `concurrency / upstream-latency`, and once that
 * approaches what the loop can retire, requests queue — and queueing shows up in
 * `router_overhead_seconds` as time the router "spent", because it did. The defaults sit an order
 * of magnitude under saturation so the reported number is per-request cost. Raising `--concurrency`
 * or dropping `--first-byte-ms` measures the saturation point instead, which is a fair thing to
 * want and a different thing to read.
 */
const DEFAULTS: DriveOptions & { readonly budgetMs: number } = {
  requests: 2_000,
  concurrency: 8,
  warmup: 200,
  promptBytes: 1_024,
  chunks: 16,
  chunkGapMs: 1,
  firstByteDelayMs: 20,
  budgetMs: 5,
}

const USAGE = `Usage: bin/bench [options]

  --requests N       requests per scenario           (default ${DEFAULTS.requests})
  --concurrency N    requests in flight              (default ${DEFAULTS.concurrency})
  --warmup N         discarded requests per scenario (default ${DEFAULTS.warmup})
  --prompt-bytes N   prompt size                     (default ${DEFAULTS.promptBytes})
  --chunks N         SSE chunks per streamed reply   (default ${DEFAULTS.chunks})
  --chunk-gap-ms N   the stub's think time per chunk (default ${DEFAULTS.chunkGapMs})
  --first-byte-ms N  the stub's time to first byte   (default ${DEFAULTS.firstByteDelayMs})
  --budget-ms N      p99 overhead ceiling            (default ${DEFAULTS.budgetMs})
  --json             emit the report as JSON
  --help             this
`

interface Options extends DriveOptions {
  readonly budgetMs: number
  readonly json: boolean
}

const NUMERIC = {
  "--requests": "requests",
  "--concurrency": "concurrency",
  "--warmup": "warmup",
  "--prompt-bytes": "promptBytes",
  "--chunks": "chunks",
  "--chunk-gap-ms": "chunkGapMs",
  "--first-byte-ms": "firstByteDelayMs",
  "--budget-ms": "budgetMs",
} as const

export function parseArgs(argv: readonly string[]): Options {
  const numbers: Record<string, number> = { ...DEFAULTS }
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === undefined) continue
    if (flag === "--json") {
      json = true
      continue
    }
    const key = NUMERIC[flag as keyof typeof NUMERIC]
    if (key === undefined) throw new Error(`unknown option ${flag}\n\n${USAGE}`)
    const raw = argv[index + 1]
    const value = raw === undefined ? Number.NaN : Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} needs a number`)
    numbers[key] = value
    index += 1
  }

  return {
    requests: numbers.requests ?? DEFAULTS.requests,
    concurrency: numbers.concurrency ?? DEFAULTS.concurrency,
    warmup: numbers.warmup ?? DEFAULTS.warmup,
    promptBytes: numbers.promptBytes ?? DEFAULTS.promptBytes,
    chunks: numbers.chunks ?? DEFAULTS.chunks,
    chunkGapMs: numbers.chunkGapMs ?? DEFAULTS.chunkGapMs,
    firstByteDelayMs: numbers.firstByteDelayMs ?? DEFAULTS.firstByteDelayMs,
    budgetMs: numbers.budgetMs ?? DEFAULTS.budgetMs,
    json,
  }
}

/** Scenarios run one at a time: two of them competing for the same event loop is not a benchmark. */
export async function bench(options: Options): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario, options))
  }
  return results
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const options = parseArgs(argv)
  const results = await bench(options)
  const outcome = verdict(results, options.budgetMs)

  process.stdout.write(
    options.json ? `${JSON.stringify(outcome, null, 2)}\n` : `${render(outcome)}\n`,
  )
  return outcome.violations.length === 0 ? 0 : 1
}

// Runs only when invoked directly, so the modules above stay importable by the tests that keep
// this harness honest (`test/integration/bench.test.ts`).
if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    })
}
