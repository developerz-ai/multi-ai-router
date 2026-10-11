/**
 * Report rendering and exit-code decision for `bin/smoke`. Pure: a report is data, the renderer
 * is a function of the data, and the exit code is a function of the leg outcomes. `main()` in
 * `run.ts` is the only caller.
 *
 * The plain-text report never includes the API key — it names `keyEnv`, the environment
 * variable, not its content. The JSON `keyEnv` field is the same name.
 */

import type { CliOptions } from "./args"
import type { LegOutcome, LegSpec } from "./grade"

export interface SmokeReport {
  readonly url: string
  readonly model: string
  readonly keyEnv: string
  readonly legs: ReadonlyArray<{
    readonly name: string
    readonly endpoint: string
    readonly stream: boolean
    readonly required: boolean
    readonly verdict: LegOutcome["verdict"]
    readonly reason?: string
    readonly status: number | null
    /** Whether a `thinking` block came back. Only set on legs whose grader reports it. */
    readonly thinkingPresent?: boolean
  }>
}

export interface LegRunResult {
  readonly leg: LegSpec
  readonly outcome: LegOutcome
  /** HTTP status of the call, or `null` if the runner never reached the wire. */
  readonly status: number | null
}

export function buildReport(options: CliOptions, results: readonly LegRunResult[]): SmokeReport {
  return {
    url: options.url,
    model: options.model,
    keyEnv: options.keyEnv,
    legs: results.map((result) => ({
      name: result.leg.name,
      endpoint: result.leg.endpoint,
      stream: result.leg.stream,
      required: result.leg.required,
      verdict: result.outcome.verdict,
      ...(result.outcome.reason === undefined ? {} : { reason: result.outcome.reason }),
      ...(result.outcome.thinkingPresent === undefined
        ? {}
        : { thinkingPresent: result.outcome.thinkingPresent }),
      status: result.status,
    })),
  }
}

export function renderReport(report: SmokeReport): string {
  const lines: string[] = []
  lines.push(`bin/smoke ${report.url} model=${report.model} keyEnv=${report.keyEnv}`)
  for (const leg of report.legs) {
    const verdict = leg.verdict
    const reason = leg.reason === undefined ? "" : ` (${leg.reason})`
    const status = leg.status === null ? "—" : String(leg.status)
    const required = leg.required ? "required " : "informational "
    const thinking =
      leg.thinkingPresent === undefined
        ? ""
        : leg.thinkingPresent
          ? " thinking=yes"
          : " thinking=no"
    lines.push(`  ${leg.name.padEnd(34)} ${required}${status} ${verdict}${reason}${thinking}`)
  }
  return `${lines.join("\n")}\n`
}

/**
 * Required legs gate the exit code; informational legs never do.
 *
 *   0  every required leg PASS
 *   1  at least one required leg FAIL
 *   2  no FAIL, but at least one required leg INCONCLUSIVE
 */
export function decideExitCode(results: readonly LegRunResult[]): number {
  let failed = false
  let inconclusive = false
  for (const result of results) {
    if (!result.leg.required) continue
    if (result.outcome.verdict === "FAIL") failed = true
    if (result.outcome.verdict === "INCONCLUSIVE") inconclusive = true
  }
  if (failed) return 1
  if (inconclusive) return 2
  return 0
}
