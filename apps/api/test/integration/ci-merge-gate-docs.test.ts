import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The merge guidance must name the CI jobs it depends on.
 *
 * Two things drift here, and nothing else in the repository notices. The `ci` workflow's job list
 * changes while the documents a maintainer reads before merging keep naming an older one. And
 * `bench` — a report that never fails the build — is easy to call a gate, or a gate a report,
 * because both read naturally in a sentence. The workflow is the truth; the prose is what a human
 * acts on, so the prose needs a guard of its own.
 *
 * The assertions are on job ids and on the workflow's own keys, never on a sentence: rewording the
 * guidance must not break this test, dropping a job from it must.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string): string => readFileSync(`${ROOT}${path}`, "utf8")

const WORKFLOW = read(".github/workflows/ci.yml")

/** The job ids the `ci` workflow defines, in the order it defines them. */
const JOB_IDS = jobIds(WORKFLOW)

/** The documents a maintainer reads to decide whether a PR may merge. */
const GUIDANCE = ["CONTRIBUTING.md", ".claude/commands/feature.md", "README.md"] as const

describe("the ci workflow", () => {
  test("defines the jobs the merge guidance names", () => {
    // The exact list, not a subset: a job added to the workflow fails here until the guidance
    // names it too, and a parser that silently found nothing cannot make the guidance
    // assertions vacuous.
    expect(JOB_IDS).toEqual([
      "lint",
      "typecheck",
      "test",
      "advisory",
      "bench",
      "ui-geometry",
      "build",
    ])
  })

  test("runs bench as a report that cannot fail the build", () => {
    const bench = withoutComments(jobBlock(WORKFLOW, "bench"))

    // Job level, four spaces in. A step-scoped key would let one failing step pass while the job
    // itself still reported a failure — that is not what "the job never fails the build" means.
    expect(bench).toMatch(/^ {4}continue-on-error: true$/m)
  })

  test("keeps advisory and ui-geometry gates", () => {
    for (const name of ["advisory", "ui-geometry"]) {
      // No `continue-on-error` anywhere in the job, at job or step level: a finding, and an
      // assessment that could not complete, both turn the build red.
      expect(withoutComments(jobBlock(WORKFLOW, name))).not.toContain("continue-on-error")
    }
  })

  test("reports on bench and gates on everything else", () => {
    const reports = JOB_IDS.filter((id) =>
      withoutComments(jobBlock(WORKFLOW, id)).includes("continue-on-error"),
    )

    expect(reports).toEqual(["bench"])
  })
})

describe("the merge guidance", () => {
  for (const path of GUIDANCE) {
    test(`${path} names every ci job in its merge instruction`, () => {
      const region = mergeRegion(read(path))

      expect(region.length).toBeGreaterThan(0)
      // Every job the workflow runs has to be named where a maintainer reads what a merge waits
      // for. A job dropped from that list is the drift this pins.
      const missing = JOB_IDS.filter(
        (id) => !region.some((paragraph) => mentionsJob(paragraph, id)),
      )
      expect(missing).toEqual([])
    })

    test(`${path} names bench a report and the rest gates`, () => {
      const region = mergeRegion(read(path))

      expect({
        benchIsARepport: region.some(
          (paragraph) => mentionsJob(paragraph, "bench") && /\breports?\b/i.test(paragraph),
        ),
        callsThemGates: region.some((paragraph) => /\bgates?\b/i.test(paragraph)),
      }).toEqual({ benchIsARepport: true, callsThemGates: true })
    })
  }
})

/**
 * The paragraphs that say when a PR may merge. A job named elsewhere — a section about
 * `bin/bench`, a table of commands — is not the merge instruction, so the check is scoped to the
 * passages that talk about merging.
 */
function mergeRegion(text: string): string[] {
  return paragraphs(text).filter((paragraph) => /\bmerge\b/i.test(paragraph))
}

/** The document's paragraphs, blank-line separated. */
function paragraphs(text: string): string[] {
  return text.split(/\n[ \t]*\n/).filter((paragraph) => paragraph.trim().length > 0)
}

/**
 * Whether the text names a CI job. The wrapper script of the same name is not the job, so a job
 * id that follows a path separator (`bin/bench`) does not count.
 */
function mentionsJob(text: string, id: string): boolean {
  return new RegExp(`(?<![\\w/-])${id}\\b`).test(text)
}

/** The job ids the `ci` workflow defines, in the order it defines them. */
function jobIds(workflow: string): string[] {
  const body = withoutComments(workflow)
  const start = body.indexOf("\njobs:\n")
  if (start === -1) throw new Error("the workflow has no jobs block")
  const ids: string[] = []
  for (const line of body.slice(start + "\njobs:\n".length).split("\n")) {
    // Two spaces of indent: a job key. Everything nested inside a job sits deeper.
    const id = /^ {2}([A-Za-z0-9_-]+):$/.exec(line)?.[1]
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/**
 * The body of one job in the workflow, up to the next job. Copied from advisory-cli.test.ts, where
 * these two helpers live; they belong in one shared module, which that file's owner has to make.
 */
function jobBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  if (start === -1) throw new Error(`the workflow has no ${name} job`)
  const rest = workflow.slice(start + 1)
  const end = rest.search(/\n {2}[a-zA-Z0-9_-]+:\n/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** The job's YAML without its comment lines. */
function withoutComments(job: string): string {
  return job
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
}
