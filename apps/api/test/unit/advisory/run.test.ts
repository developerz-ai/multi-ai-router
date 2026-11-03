import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_OSV_URL, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS } from "../../../advisory/osv"
import { type AdvisoryReport, buildReport, renderSummary } from "../../../advisory/report"
import { main, parseArgs } from "../../../advisory/run"
import type { AdvisoryFinding, AdvisoryStatus } from "../../../advisory/verdict"

/**
 * `bin/advisory`, driven in process.
 *
 * The command is what the CI gate runs, and this is the only test that touches the module that
 * decides its exit code. Importing it here is also what puts `advisory/run.ts` and
 * `advisory/report.ts` into the tests TypeScript project (`apps/api/tsconfig.tests.json`), so the
 * typecheck checks the code the whole advisory job depends on — before this import existed,
 * neither file was in any TypeScript program.
 *
 * The fixtures are synthetic: a made-up package name in a made-up lockfile, and a base URL that
 * cannot be parsed. Nothing here reaches the real advisory service.
 */

const ADVISORY_ID = "SYNTHETIC-ADVISORY-0001"
const PACKAGE = "synthetic-advisory-fixture"

const FINDING: AdvisoryFinding = {
  id: ADVISORY_ID,
  package: PACKAGE,
  version: "1.0.0",
  severity: "HIGH",
  summary: "Synthetic fixture advisory",
  fixed: "2.0.0",
  url: `https://osv.dev/vulnerability/${ADVISORY_ID}`,
}

/** The report as it is written to disk. */
interface WrittenReport {
  readonly status: string
  readonly source: string
  readonly packagesAssessed: number
  readonly findings: readonly unknown[]
  readonly error: string | null
}

/** A report of the shape the gate writes, with the parts a test cares about. */
function report(
  status: AdvisoryStatus,
  findings: readonly AdvisoryFinding[] = [],
  error: string | null = null,
): AdvisoryReport {
  return buildReport({
    status,
    source: DEFAULT_OSV_URL,
    assessedAt: "2026-01-01T00:00:00.000Z",
    packagesAssessed: 1,
    findings,
    error,
  })
}

/** A temporary directory holding a lockfile with one synthetic package in it. */
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "router-advisory-run-"))
  writeFileSync(
    join(directory, "bun.lock"),
    `{
  "lockfileVersion": 3,
  "packages": {
    "${PACKAGE}": ["${PACKAGE}@1.0.0", "", {}],
  },
}
`,
  )
  return directory
}

/** Runs the command with its output captured, so the summary can be read. */
async function capture(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  const write = spyOn(process.stdout, "write").mockImplementation(() => true)
  try {
    const code = await run()
    const output = write.mock.calls.map((call) => String(call[0])).join("")
    return { code, output }
  } finally {
    write.mockRestore()
  }
}

function readReport(path: string): WrittenReport {
  return JSON.parse(readFileSync(path, "utf8")) as WrittenReport
}

describe("the options of the command", () => {
  test("read this repository's lockfile and the live advisory database by default", () => {
    const options = parseArgs([])

    expect(options.lockfilePath).toBe("bun.lock")
    expect(options.osvUrl).toBe(DEFAULT_OSV_URL)
    expect(options.reportPath).toBeUndefined()
    expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(options.retries).toBe(DEFAULT_RETRIES)
  })

  test("take every option they are given", () => {
    const options = parseArgs([
      "--lockfile",
      "/tmp/bun.lock",
      "--osv-url",
      "http://127.0.0.1:9",
      "--report",
      "/tmp/advisory-report.json",
      "--timeout-ms",
      "1500",
      "--retries",
      "0",
    ])

    expect(options).toEqual({
      lockfilePath: "/tmp/bun.lock",
      osvUrl: "http://127.0.0.1:9",
      reportPath: "/tmp/advisory-report.json",
      timeoutMs: 1500,
      retries: 0,
    })
  })

  test("refuse an option they do not know", () => {
    expect(() => parseArgs(["--verbose"])).toThrow("unknown option --verbose")
  })

  test("refuse a flag with no value behind it", () => {
    expect(() => parseArgs(["--lockfile"])).toThrow("--lockfile needs a value")
    expect(() => parseArgs(["--report"])).toThrow("--report needs a value")
  })

  test("refuse a number that is not a number", () => {
    expect(() => parseArgs(["--timeout-ms", "soon"])).toThrow("--timeout-ms needs a number")
    expect(() => parseArgs(["--retries", "-1"])).toThrow("--retries needs a number")
  })

  test("accept a timeout of zero — it is a number, and it is not a negative one", () => {
    expect(parseArgs(["--timeout-ms", "0"]).timeoutMs).toBe(0)
  })
})

describe("the run", () => {
  test("prints the usage and exits 0 when it is asked for help", async () => {
    const { code, output } = await capture(() => main(["--help"]))

    expect(code).toBe(0)
    expect(output).toContain("Usage: bin/advisory")
    // The usage names the defaults the run actually uses, so the two cannot drift apart.
    expect(output).toContain("(default bun.lock)")
    expect(output).toContain(`(default ${DEFAULT_OSV_URL})`)
    expect(output).toContain(`(default ${DEFAULT_TIMEOUT_MS})`)
    expect(output).toContain(`(default ${DEFAULT_RETRIES})`)
    expect(output).toContain("Exit codes: 0 clean, 1 finding, 2 unavailable")
  })

  test("answers the request for help before it looks at the other arguments", async () => {
    const { code } = await capture(() => main(["--not-an-option", "--help"]))

    expect(code).toBe(0)
  })

  test("fails the run on an option it does not know", async () => {
    await expect(capture(() => main(["--not-an-option"]))).rejects.toThrow(
      "unknown option --not-an-option",
    )
  })

  test("exits 2 and still writes the report when the lockfile cannot be read", async () => {
    const directory = fixture()
    try {
      const reportPath = join(directory, "advisory-report.json")
      const { code, output } = await capture(() =>
        main([
          "--lockfile",
          join(directory, "does-not-exist.lock"),
          "--osv-url",
          "not a url/",
          "--report",
          reportPath,
          "--retries",
          "0",
        ]),
      )

      // A tree that cannot be read is not a tree with no advisories: the run exits 2 and the
      // report says why.
      expect(code).toBe(2)
      const written = readReport(reportPath)
      expect(written.status).toBe("unavailable")
      expect(written.error).not.toBeNull()
      expect(written.findings).toEqual([])
      expect(written.packagesAssessed).toBe(0)
      // The source is the database the gate was pointed at, without its trailing slash.
      expect(written.source).toBe("not a url")
      expect(output).toContain("status: unavailable")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("exits 2 when the advisory database cannot be reached", async () => {
    const directory = fixture()
    try {
      const reportPath = join(directory, "advisory-report.json")
      const { code, output } = await capture(() =>
        main([
          "--lockfile",
          join(directory, "bun.lock"),
          "--osv-url",
          "not a url",
          "--report",
          reportPath,
          "--retries",
          "0",
        ]),
      )

      // The failure this guards: a gate that could not reach the database reading as a clean
      // pass. The exit code says 2 and the report says unavailable — never clean.
      expect(code).toBe(2)
      const written = readReport(reportPath)
      expect(written.status).toBe("unavailable")
      expect(written.status).not.toBe("clean")
      expect(written.error).not.toBeNull()
      expect(written.packagesAssessed).toBe(1)
      expect(output).toContain("status: unavailable")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("the report", () => {
  test("keeps the shape it was built from", () => {
    const built = report("clean")

    expect(built.version).toBe(1)
    expect(built.status).toBe("clean")
    expect(built.source).toBe(DEFAULT_OSV_URL)
    expect(built.assessedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(built.packagesAssessed).toBe(1)
    expect(built.findings).toEqual([])
    expect(built.error).toBeNull()
  })

  test("the summary of a clean assessment says so, in the report's own words", () => {
    const summary = renderSummary(report("clean"))

    expect(summary).toContain("status: clean")
    expect(summary).toContain("packages assessed: 1")
    expect(summary).toContain("PASS")
    expect(summary).not.toContain("FAIL")
    expect(summary).not.toContain("UNAVAILABLE")
  })

  test("the summary of a finding names the advisory, its package and its fix", () => {
    const summary = renderSummary(report("finding", [FINDING]))

    expect(summary).toContain("status: finding")
    expect(summary).toContain(ADVISORY_ID)
    expect(summary).toContain(`${PACKAGE}@1.0.0`)
    expect(summary).toContain("HIGH")
    expect(summary).toContain("fixed in 2.0.0")
    expect(summary).toContain(FINDING.url)
    expect(summary).toContain("FAIL")
    expect(summary).not.toContain("PASS")
  })

  test("the summary says when the database records no fix", () => {
    const summary = renderSummary(report("finding", [{ ...FINDING, fixed: null }]))

    expect(summary).toContain("no fix recorded")
  })

  test("the summary counts the advisories it found", () => {
    const one = renderSummary(report("finding", [FINDING]))
    const two = renderSummary(
      report("finding", [FINDING, { ...FINDING, package: "other-fixture" }]),
    )

    expect(one).toContain("1 advisory affect")
    expect(two).toContain("2 advisories affect")
  })

  test("the summary of an assessment that could not complete says why", () => {
    const summary = renderSummary(report("unavailable", [], "the network is unreachable"))

    expect(summary).toContain("status: unavailable")
    expect(summary).toContain("error: the network is unreachable")
    expect(summary).toContain("UNAVAILABLE")
    expect(summary).not.toContain("PASS")
    expect(summary).not.toContain("FAIL")
  })
})
