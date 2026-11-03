/**
 * The decision layer: what the assessment found, and what the run does about it.
 *
 * Pure — findings and availability in, one status and one exit code out. No clock, no network, no
 * filesystem. That is what keeps the three outcomes apart: the rule that decides them is one
 * function, readable in one sitting, and it is the only place a status is ever produced.
 *
 * **The three outcomes never collapse.** `clean` means the assessment completed and found nothing.
 * `finding` means it completed and found something. `unavailable` means it did not complete — and
 * an assessment that could not reach the advisory database has proved nothing about the
 * dependencies, so it is not a clean pass with a warning attached. A red "unknown" beats a green
 * "clean": the tree might be fine, but nobody has shown that it is.
 */

/** The three outcomes, and nothing else. */
export type AdvisoryStatus = "clean" | "finding" | "unavailable"

/** One advisory against one resolved package. */
export interface AdvisoryFinding {
  readonly id: string
  readonly package: string
  readonly version: string
  readonly severity: string
  readonly summary: string
  /** The first version OSV records as fixing this advisory, when it records one. */
  readonly fixed: string | null
  readonly url: string
}

/** What an assessment produced. `error` is null exactly when the assessment completed. */
export interface Assessment {
  readonly findings: readonly AdvisoryFinding[]
  /** Why the assessment could not complete, or null when it did. */
  readonly error: string | null
}

/**
 * The status of an assessment.
 *
 * Availability is checked first: an assessment that failed part-way still holds the findings it
 * collected on the way, and reporting those as `finding` would claim a fact the run did not
 * establish — the finding is real, the *completeness* of the assessment is not.
 */
export function statusOf(assessment: Assessment): AdvisoryStatus {
  if (assessment.error !== null) return "unavailable"
  if (assessment.findings.length > 0) return "finding"
  return "clean"
}

/**
 * The exit code of a status.
 *
 * Three codes, three meanings, never reused:
 *   0 — the assessment completed and found no advisory
 *   1 — the assessment completed and found at least one advisory
 *   2 — the assessment did not complete
 *
 * The default branch is a type-level exhaustiveness check rather than a fallback: a fourth status
 * added to the union without a code here fails the build instead of quietly exiting 0.
 */
export function exitCodeFor(status: AdvisoryStatus): 0 | 1 | 2 {
  switch (status) {
    case "clean":
      return 0
    case "finding":
      return 1
    case "unavailable":
      return 2
    default: {
      const unknown: never = status
      throw new Error(`unknown advisory status: ${String(unknown)}`)
    }
  }
}
