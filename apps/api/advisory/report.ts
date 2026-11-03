/**
 * The report file, and the summary a person reads.
 *
 * One shape for all three outcomes. A report that only exists when the answer is interesting is
 * not evidence — a reviewer asking "did the gate actually run, and what did it say?" gets an
 * answer for a clean run, a finding and an assessment that could not complete alike. So the file
 * is written on every outcome, and `status` is the field the CI job summary reads.
 *
 * The file is JSON because something else reads it: `jq` over `status` in the job summary, and a
 * human downloading the artifact. The summary printed to stdout is the same information shaped for
 * a terminal.
 */

import type { AdvisoryFinding, AdvisoryStatus } from "./verdict"

/** Bumped when the shape changes; a reader that does not know this version must not guess. */
export const REPORT_VERSION = 1

/** The report as it is written to disk. */
export interface AdvisoryReport {
  readonly version: typeof REPORT_VERSION
  readonly status: AdvisoryStatus
  /** The advisory database that was queried. */
  readonly source: string
  /** ISO-8601, when the assessment ran. */
  readonly assessedAt: string
  /** How many resolved packages the assessment covered. */
  readonly packagesAssessed: number
  readonly findings: readonly AdvisoryFinding[]
  /** Why the assessment could not complete, or null when it did. */
  readonly error: string | null
}

/** The inputs a report is built from. */
export interface ReportInput {
  readonly status: AdvisoryStatus
  readonly source: string
  readonly assessedAt: string
  readonly packagesAssessed: number
  readonly findings: readonly AdvisoryFinding[]
  readonly error: string | null
}

export function buildReport(input: ReportInput): AdvisoryReport {
  return {
    version: REPORT_VERSION,
    status: input.status,
    source: input.source,
    assessedAt: input.assessedAt,
    packagesAssessed: input.packagesAssessed,
    findings: input.findings,
    error: input.error,
  }
}

/** The file, as written. A trailing newline so the artifact is a text file and not a blob. */
export function serializeReport(report: AdvisoryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * The summary printed to stdout.
 *
 * The status is the first thing on it, in the same words the report file uses, because the two
 * are read side by side — a log line that said "FAILED" next to a report that said `finding`
 * would leave a reader guessing which one was true.
 */
export function renderSummary(report: AdvisoryReport): string {
  const lines = [
    `advisory — ${report.source}`,
    `status: ${report.status}`,
    `assessed at: ${report.assessedAt}`,
    `packages assessed: ${report.packagesAssessed}`,
  ]

  if (report.error !== null) {
    lines.push(`error: ${report.error}`)
  }

  if (report.findings.length > 0) {
    lines.push(`findings (${report.findings.length}):`)
    for (const finding of report.findings) {
      const fixed = finding.fixed === null ? "no fix recorded" : `fixed in ${finding.fixed}`
      lines.push(
        `  ${finding.id}  ${finding.package}@${finding.version}  ${finding.severity}  ${fixed}`,
      )
      lines.push(`    ${finding.summary}`)
      lines.push(`    ${finding.url}`)
    }
  }

  const count = report.findings.length
  lines.push(
    report.status === "clean"
      ? "PASS — the assessment completed and found no advisory"
      : report.status === "finding"
        ? `FAIL — ${count} ${count === 1 ? "advisory" : "advisories"} affect the resolved dependency set`
        : "UNAVAILABLE — the assessment did not complete, so the dependency set is unproven",
  )

  return lines.join("\n")
}
