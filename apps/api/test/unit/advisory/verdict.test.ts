import { describe, expect, test } from "bun:test"
import { type AdvisoryFinding, exitCodeFor, statusOf } from "../../../advisory/verdict"

/**
 * The decision layer, and the rule the whole gate rests on: the three outcomes never collapse.
 *
 * The fixtures are hand-built, so each branch is driven rather than waited for — an assessment
 * that could not complete is not something a healthy network produces on demand.
 */

const FINDING: AdvisoryFinding = {
  id: "SYNTHETIC-ADVISORY-0001",
  package: "synthetic-advisory-fixture",
  version: "1.0.0",
  severity: "HIGH",
  summary: "Synthetic fixture advisory",
  fixed: "2.0.0",
  url: "https://osv.dev/vulnerability/SYNTHETIC-ADVISORY-0001",
}

describe("the status of an assessment", () => {
  test("no findings and no error is clean", () => {
    expect(statusOf({ findings: [], error: null })).toBe("clean")
  })

  test("one finding is a finding", () => {
    expect(statusOf({ findings: [FINDING], error: null })).toBe("finding")
  })

  test("an assessment that could not complete is unavailable", () => {
    expect(statusOf({ findings: [], error: "the network is unreachable" })).toBe("unavailable")
  })

  test("an assessment that failed part-way is unavailable, not a finding", () => {
    // The finding it collected is real, but the assessment did not complete — reporting it as a
    // `finding` would claim a completeness the run never established.
    expect(statusOf({ findings: [FINDING], error: "the network is unreachable" })).toBe(
      "unavailable",
    )
  })
})

describe("the exit code of a status", () => {
  test("clean is 0, finding is 1, unavailable is 2", () => {
    expect(exitCodeFor("clean")).toBe(0)
    expect(exitCodeFor("finding")).toBe(1)
    expect(exitCodeFor("unavailable")).toBe(2)
  })

  test("the three outcomes keep three different exit codes", () => {
    const codes = [exitCodeFor("clean"), exitCodeFor("finding"), exitCodeFor("unavailable")]

    expect(new Set(codes).size).toBe(3)
  })

  test("unavailable is never exit 0", () => {
    // The failure this guards: a gate that could not reach the database reading as a clean pass.
    expect(exitCodeFor("unavailable")).not.toBe(0)
    expect(exitCodeFor("unavailable")).not.toBe(exitCodeFor("clean"))
  })
})
