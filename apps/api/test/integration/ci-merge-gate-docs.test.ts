import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The merge guidance must name the CI jobs it depends on, and classify each one the way the
 * workflow itself runs it.
 *
 * Three things drift here, and nothing else in the repository notices. The `ci` workflow's job
 * list changes while the documents a maintainer reads before merging keep naming an older one.
 * `bench` — a report that never fails the build — is easy to call a gate, or a gate a report,
 * because both read naturally in a sentence. And the right words near the right job names are
 * not a classification: "bench is a gate; advisory and ui-geometry are reports" coexists with
 * every word a presence check looks for. The workflow is the truth; the prose is what a human
 * acts on, so the prose needs a guard of its own.
 *
 * The assertions are on job ids and on the workflow's own keys, except the classification check,
 * which must read a sentence: binding "gate" or "report" to a job needs the sentence that says
 * it. A reword survives as long as every classification sentence names its jobs next to exactly
 * one of the two words; a fixture with the classifications reversed pins that the matcher reads
 * the classification, not the coexistence.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string): string => readFileSync(`${ROOT}${path}`, "utf8")

const WORKFLOW = read(".github/workflows/ci.yml")

/** The job ids the `ci` workflow defines, in the order it defines them. */
const JOB_IDS = jobIds(WORKFLOW)

type Classification = "report" | "gate"

/**
 * How the workflow itself runs a job: `continue-on-error` at job level is a report that cannot
 * fail the build; anything else is a gate a merge waits on.
 */
const runsAs = (id: string): Classification =>
  /^ {4}continue-on-error: true$/m.test(withoutComments(jobBlock(WORKFLOW, id))) ? "report" : "gate"

/** The documents a maintainer reads to decide whether a PR may merge. */
const GUIDANCE = ["CONTRIBUTING.md", ".claude/commands/feature.md", "README.md"] as const

/**
 * The negative fixture: prose in the same shape as the guidance, with the classifications
 * reversed — `bench` a gate, the gates reports. Every job and every word the matcher looks for
 * is present; only the classification is wrong.
 */
const REVERSED = `
Reversed merge guidance

A merge waits for the bench gate to pass. A merge then reads the advisory, ui-geometry, lint,
typecheck, test and build reports before it goes green.
`

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
    // The classification the guidance is held to, read off the workflow's own keys.
    expect(JOB_IDS.filter((id) => runsAs(id) === "report")).toEqual(["bench"])
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

    test(`${path} classifies every job the way the workflow runs it`, () => {
      // Per job: a document that called bench a gate and the gates reports carries every word
      // this looks for, and still fails here.
      expect(guidanceProblems(read(path))).toEqual([])
    })
  }

  test("a fixture with the classifications reversed fails", () => {
    expect(guidanceProblems(REVERSED)).toEqual([
      "lint is called a report but the workflow gates on it",
      "typecheck is called a report but the workflow gates on it",
      "test is called a report but the workflow gates on it",
      "advisory is called a report but the workflow gates on it",
      "bench is called a gate but the workflow reports it",
      "ui-geometry is called a report but the workflow gates on it",
      "build is called a report but the workflow gates on it",
    ])
  })
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

/** The paragraph's sentences: terminal punctuation followed by whitespace ends one. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0)
}

/**
 * Every way the document's merge instruction classifies a job against how the workflow runs it:
 * never classifying it, classifying it both ways, or calling a gate a report or the reverse. A
 * sentence classifies the jobs it names when it carries exactly one of the two words — a sentence
 * with both (or neither) asserts nothing, so hedged prose cannot classify.
 */
function guidanceProblems(text: string): string[] {
  const classified = new Map<string, Set<Classification>>()
  for (const paragraph of mergeRegion(text)) {
    for (const sentence of sentences(paragraph)) {
      const saysReport = /\breports?\b/i.test(sentence)
      const saysGate = /\bgates?\b/i.test(sentence)
      if (saysReport === saysGate) continue
      const kind: Classification = saysReport ? "report" : "gate"
      for (const id of JOB_IDS) {
        if (!mentionsJob(sentence, id)) continue
        const kinds = classified.get(id) ?? new Set<Classification>()
        kinds.add(kind)
        classified.set(id, kinds)
      }
    }
  }

  const problems: string[] = []
  for (const id of JOB_IDS) {
    const kinds = classified.get(id)
    if (kinds === undefined || kinds.size === 0) {
      problems.push(`${id} is never classified`)
    } else if (kinds.size > 1) {
      problems.push(`${id} is called both a report and a gate`)
    } else if (!kinds.has(runsAs(id))) {
      problems.push(
        runsAs(id) === "report"
          ? `${id} is called a gate but the workflow reports it`
          : `${id} is called a report but the workflow gates on it`,
      )
    }
  }
  return problems
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
