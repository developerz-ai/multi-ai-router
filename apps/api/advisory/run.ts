/**
 * `bin/advisory` — the live advisory assessment, as a command.
 *
 * Reads the resolved packages out of `bun.lock`, asks OSV.dev about each of them, writes the report
 * and prints the summary. The three outcomes and their exit codes live in `./verdict`; this file
 * is the wiring, and nothing else.
 *
 * `main` is exported so the test in `apps/api/test/unit/advisory/run.test.ts` can drive this
 * command in process. That import is also what puts this file, and the `./report` module it
 * imports, into the tests TypeScript project (`apps/api/tsconfig.tests.json`), so the typecheck
 * checks the code that decides the gate's exit code. Before that import existed, neither file
 * was in any TypeScript program.
 *
 * The auto-run below is guarded by `import.meta.main`, so importing the module never starts an
 * assessment.
 *
 * A failure to even read the lockfile is an outcome, not a crash: the report is written and the
 * run exits 2. That is the point of the third outcome — an assessment that could not complete
 * leaves evidence and turns the build red, instead of quietly reading as a clean pass.
 */

import { LockfileParseError, parseLockfile, type ResolvedPackage } from "./lockfile"
import {
  assess,
  DEFAULT_OSV_URL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  normalizeBaseUrl,
} from "./osv"
import { type AdvisoryReport, buildReport, renderSummary, serializeReport } from "./report"
import { exitCodeFor } from "./verdict"

const USAGE = `Usage: bin/advisory [options]

  --lockfile PATH   the lockfile to read        (default bun.lock)
  --osv-url URL     the advisory database        (default ${DEFAULT_OSV_URL})
  --report PATH     write the JSON report here
  --timeout-ms N    per-request timeout          (default ${DEFAULT_TIMEOUT_MS})
  --retries N       retries per request          (default ${DEFAULT_RETRIES})
  --help            this

Exit codes: 0 clean, 1 finding, 2 unavailable (the assessment did not complete).
`

export interface AdvisoryOptions {
  readonly lockfilePath: string
  readonly osvUrl: string
  readonly reportPath: string | undefined
  readonly timeoutMs: number
  readonly retries: number
}

export function parseArgs(argv: readonly string[]): AdvisoryOptions {
  let lockfilePath = "bun.lock"
  let osvUrl = DEFAULT_OSV_URL
  let reportPath: string | undefined
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let retries = DEFAULT_RETRIES

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === undefined) continue
    if (flag === "--lockfile") {
      index += 1
      lockfilePath = value(argv, index, flag)
      continue
    }
    if (flag === "--osv-url") {
      index += 1
      osvUrl = value(argv, index, flag)
      continue
    }
    if (flag === "--report") {
      index += 1
      reportPath = value(argv, index, flag)
      continue
    }
    if (flag === "--timeout-ms") {
      index += 1
      timeoutMs = number(value(argv, index, flag), flag)
      continue
    }
    if (flag === "--retries") {
      index += 1
      retries = number(value(argv, index, flag), flag)
      continue
    }
    throw new Error(`unknown option ${flag}\n\n${USAGE}`)
  }

  return { lockfilePath, osvUrl, reportPath, timeoutMs, retries }
}

function value(argv: readonly string[], index: number, flag: string): string {
  const raw = argv[index]
  if (raw === undefined) throw new Error(`${flag} needs a value`)
  return raw
}

function number(raw: string, flag: string): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} needs a number`)
  return parsed
}

/**
 * The run.
 *
 * Returns the exit code rather than setting it, so a test can call it and read the answer.
 */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const options = parseArgs(argv)
  const report = await assessTree(options)
  if (options.reportPath !== undefined) {
    await Bun.write(options.reportPath, serializeReport(report))
  }
  process.stdout.write(`${renderSummary(report)}\n`)
  return exitCodeFor(report.status)
}

/** The assessment, and the report it produces — written on every outcome. */
async function assessTree(options: AdvisoryOptions): Promise<AdvisoryReport> {
  const source = normalizeBaseUrl(options.osvUrl)
  const assessedAt = new Date().toISOString()

  let packages: readonly ResolvedPackage[]
  try {
    packages = parseLockfile(await readLockfile(options.lockfilePath))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return buildReport({
      status: "unavailable",
      source,
      assessedAt,
      packagesAssessed: 0,
      findings: [],
      error: reason,
    })
  }

  const assessment = await assess(packages, {
    baseUrl: options.osvUrl,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  })

  return buildReport({
    status: assessment.status,
    source,
    assessedAt,
    packagesAssessed: assessment.packagesAssessed,
    findings: assessment.findings,
    error: assessment.error,
  })
}

async function readLockfile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new LockfileParseError(`could not read ${path}: ${reason}`)
  }
}

// Runs only when invoked directly, so the module stays importable by the tests that keep this
// command honest.
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
