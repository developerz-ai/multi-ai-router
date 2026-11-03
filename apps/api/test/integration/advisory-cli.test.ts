import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * `bin/advisory`, end to end, against a local fixture server.
 *
 * The server mimics OSV.dev: a `querybatch` that answers with one result per query and a
 * `v1/vulns/<id>` that answers with the advisory. The package name and the advisory id are both
 * synthetic, so no real vulnerable dependency enters this repository and no test reaches the real
 * OSV service.
 *
 * The three outcomes are asserted as what a gate is judged on: the exit code, the report file and
 * the printed summary. A run that cannot complete must be visibly different from a clean one —
 * not a warning in the log, a different exit code.
 *
 * The child is spawned asynchronously on purpose: the fixture server lives in this process, so a
 * synchronous spawn would block the event loop that has to answer the child's request.
 */

const ROOT = resolve(import.meta.dir, "../../../..")
const ADVISORY_ID = "SYNTHETIC-ADVISORY-0001"
const PACKAGE = "synthetic-advisory-fixture"

interface Report {
  readonly version: number
  readonly status: string
  readonly source: string
  readonly assessedAt: string
  readonly packagesAssessed: number
  readonly findings: readonly {
    readonly id: string
    readonly package: string
    readonly version: string
    readonly severity: string
    readonly summary: string
    readonly fixed: string | null
    readonly url: string
  }[]
  readonly error: string | null
}

interface Fixture {
  readonly url: string
  stop(): void
}

/** A server that answers like OSV.dev, with the three behaviours the gate has to tell apart. */
function serve(options: { readonly advisory: boolean; readonly failWith?: number }): Fixture {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (options.failWith !== undefined) {
        return new Response("upstream failure", { status: options.failWith })
      }
      if (request.method === "POST" && url.pathname === "/v1/querybatch") {
        const body = (await request.json()) as { queries?: unknown[] }
        const results = (body.queries ?? []).map(() =>
          options.advisory ? { vulns: [{ id: ADVISORY_ID }] } : {},
        )
        return Response.json({ results })
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/vulns/")) {
        return Response.json({
          id: ADVISORY_ID,
          summary: "Synthetic fixture advisory",
          database_specific: { severity: "HIGH" },
          affected: [
            {
              package: { ecosystem: "npm", name: PACKAGE },
              ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }],
            },
          ],
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** A lockfile holding one synthetic package — JSONC, like the real one. */
function fixtureLockfile(directory: string): string {
  const path = join(directory, "bun.lock")
  writeFileSync(
    path,
    `{
  "lockfileVersion": 3,
  "packages": {
    "${PACKAGE}": ["${PACKAGE}@1.0.0", "", {}],
  },
}
`,
  )
  return path
}

interface Run {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs the real command, the way CI runs it. */
async function runAdvisory(args: readonly string[]): Promise<Run> {
  const child = Bun.spawn([join(ROOT, "bin/advisory"), ...args], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report
}

describe("bin/advisory", () => {
  test("a completed assessment with no advisory exits 0 and writes a clean report", async () => {
    const fixture = serve({ advisory: false })
    const directory = mkdtempSync(join(tmpdir(), "router-advisory-"))
    try {
      const reportPath = join(directory, "advisory-report.json")
      const run = await runAdvisory([
        "--lockfile",
        fixtureLockfile(directory),
        "--osv-url",
        fixture.url,
        "--report",
        reportPath,
      ])

      expect(run.exitCode).toBe(0)
      const report = readReport(reportPath)
      expect(report.version).toBe(1)
      expect(report.status).toBe("clean")
      expect(report.findings).toEqual([])
      expect(report.error).toBeNull()
      expect(report.packagesAssessed).toBe(1)
      expect(report.source).toBe(fixture.url)
      expect(report.assessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(run.stdout).toContain("status: clean")
    } finally {
      rmSync(directory, { recursive: true, force: true })
      fixture.stop()
    }
  })

  test("one advisory exits 1 and writes a report naming it", async () => {
    const fixture = serve({ advisory: true })
    const directory = mkdtempSync(join(tmpdir(), "router-advisory-"))
    try {
      const reportPath = join(directory, "advisory-report.json")
      const run = await runAdvisory([
        "--lockfile",
        fixtureLockfile(directory),
        "--osv-url",
        fixture.url,
        "--report",
        reportPath,
      ])

      expect(run.exitCode).toBe(1)
      const report = readReport(reportPath)
      expect(report.status).toBe("finding")
      expect(report.findings).toHaveLength(1)
      expect(report.findings[0]?.id).toBe(ADVISORY_ID)
      expect(report.findings[0]?.package).toBe(PACKAGE)
      expect(report.findings[0]?.version).toBe("1.0.0")
      expect(run.stdout).toContain("status: finding")
      expect(run.stdout).toContain(ADVISORY_ID)
    } finally {
      rmSync(directory, { recursive: true, force: true })
      fixture.stop()
    }
  })

  test("an assessment that could not complete exits 2 and writes an unavailable report", async () => {
    const fixture = serve({ advisory: false, failWith: 500 })
    const directory = mkdtempSync(join(tmpdir(), "router-advisory-"))
    try {
      const reportPath = join(directory, "advisory-report.json")
      const run = await runAdvisory([
        "--lockfile",
        fixtureLockfile(directory),
        "--osv-url",
        fixture.url,
        "--report",
        reportPath,
        "--retries",
        "0",
      ])

      // The report is written on this outcome too: a run that could not complete still leaves
      // evidence, and the file says why.
      expect(run.exitCode).toBe(2)
      const report = readReport(reportPath)
      expect(report.status).toBe("unavailable")
      expect(report.status).not.toBe("clean")
      expect(report.error).not.toBeNull()
      expect(run.stdout).toContain("status: unavailable")
    } finally {
      rmSync(directory, { recursive: true, force: true })
      fixture.stop()
    }
  })

  test("a lockfile that cannot be read exits 2 and still writes a report", async () => {
    const fixture = serve({ advisory: false })
    const directory = mkdtempSync(join(tmpdir(), "router-advisory-"))
    try {
      const reportPath = join(directory, "advisory-report.json")
      const run = await runAdvisory([
        "--lockfile",
        join(directory, "does-not-exist.lock"),
        "--osv-url",
        fixture.url,
        "--report",
        reportPath,
      ])

      expect(run.exitCode).toBe(2)
      expect(readReport(reportPath).status).toBe("unavailable")
    } finally {
      rmSync(directory, { recursive: true, force: true })
      fixture.stop()
    }
  })
})

describe("the CI job", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")

  test("runs the assessment as a gate, after the test job", () => {
    const job = jobBlock(workflow, "advisory")

    expect(job).toContain("bin/advisory --report advisory-report.json")
    // A finding must turn the default branch red: no `continue-on-error`, at job or step level.
    // The comments are stripped first — the rule is about the key, not about the words.
    expect(withoutComments(job)).not.toContain("continue-on-error")
    expect(workflow.indexOf("\n  advisory:")).toBeGreaterThan(workflow.indexOf("\n  test:"))
  })

  test("uploads the report and names the status in the job summary", () => {
    const job = jobBlock(workflow, "advisory")
    const upload = stepWith(job, "uses: actions/upload-artifact")
    const summary = stepWith(job, "GITHUB_STEP_SUMMARY")

    expect(upload).toContain("name: advisory-report")
    expect(upload).toContain("path: advisory-report.json")
    expect(upload).toContain("if-no-files-found: error")
    expect(summary).toContain("jq")
  })

  test("keeps the assessment evidence on a failing assessment", () => {
    const job = jobBlock(workflow, "advisory")
    const upload = stepWith(job, "uses: actions/upload-artifact")
    const summary = stepWith(job, "GITHUB_STEP_SUMMARY")

    // Pinned to the steps, not to the job: the summary step carries an `if: always()` of its own,
    // so a job-wide assertion stays green while the artifact stops being uploaded on a failing
    // assessment (exit 1 or 2) — the outcome that needs the evidence most.
    expect(upload).toContain("if: always()")
    expect(summary).toContain("if: always()")
  })
})

/** The body of one job in the workflow, up to the next job. */
function jobBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  if (start === -1) throw new Error(`the workflow has no ${name} job`)
  const rest = workflow.slice(start + 1)
  const end = rest.search(/\n {2}[a-zA-Z0-9_-]+:\n/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** The steps of one job, each as its own block. */
function jobSteps(job: string): string[] {
  return job.split(/^(?= {6}- )/m).filter((block) => /^ {6}- /.test(block))
}

/** The job step that contains `needle`; the job must have it, or the test fails loudly. */
function stepWith(job: string, needle: string): string {
  const match = jobSteps(job).find((step) => step.includes(needle))
  if (match === undefined) throw new Error(`no job step contains ${needle}`)
  return match
}

/** The job's YAML without its comment lines. */
function withoutComments(job: string): string {
  return job
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
}
