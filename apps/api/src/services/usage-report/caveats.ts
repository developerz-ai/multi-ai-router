import { isoDay } from "./period"
import type { ReportCaveat, ReportCoverage, ReportPeriod } from "./types"

/**
 * The qualifications a reader needs to trust the figures, as data. Text is plain and carries no
 * account label: the report is rendered into an email-style attachment by delivery (#229).
 */

const MINUTE_MS = 60_000

/** Whether the unpriced measure covers none, part, or all of the week. */
export function unpricedCoverage(period: ReportPeriod): ReportCoverage["unpricedMeasured"] {
  const lastDay = isoDay(new Date(period.end.getTime() - 86_400_000))
  // `infinity` sorts after every date, which is the intent: never measured.
  if (period.unpricedSince > lastDay) return "none"
  return period.unpricedSince <= isoDay(period.start) ? "full" : "partial"
}

export function reportCoverage(period: ReportPeriod): ReportCoverage {
  const gap = Math.max(
    0,
    Math.floor((period.generatedAt.getTime() - period.end.getTime()) / MINUTE_MS),
  )
  return {
    timeBasis: "event-time",
    requestsDatedBy: "settled-at",
    attemptsDatedBy: "started-at",
    upstreamTimeoutMs: period.upstreamTimeoutMs,
    generatedAfterPeriodEndMinutes: gap,
    settleCoversUpstreamTimeout: gap * MINUTE_MS >= period.upstreamTimeoutMs,
    unpricedSince: period.unpricedSince,
    unpricedMeasured: unpricedCoverage(period),
  }
}

export function reportCaveats(input: {
  readonly period: ReportPeriod
  readonly coverage: ReportCoverage
  readonly unpriced: number | null
  /** Attempts on days the unpriced measure covers: the share's denominator. */
  readonly measuredAttempts: number
}): ReportCaveat[] {
  const { period, coverage } = input
  const start = isoDay(period.start)
  const end = isoDay(period.end)
  const timeoutMinutes = Math.round(period.upstreamTimeoutMs / MINUTE_MS)

  const unpricedText =
    coverage.unpricedMeasured === "none" || input.unpriced === null
      ? `Unpriced attempts were not measured for this week (the measure starts ${coverage.unpricedSince}); the figures say nothing about traffic the price table could not see.`
      : `${input.unpriced} of ${input.measuredAttempts} attempts (${percent(input.unpriced, input.measuredAttempts)}) used tokens the price table could not price, so their cost is missing from METERED and NOTIONAL.${
          coverage.unpricedMeasured === "partial"
            ? ` The measure starts ${coverage.unpricedSince}, partway through the week, so both the count and the attempts it is divided by cover only the days from then.`
            : ""
        }`

  return [
    { code: "unpriced_share", text: unpricedText },
    {
      code: "overflow_designation",
      text: `Overflow share uses each pool's overflow account as designated when this report was generated (${period.generatedAt.toISOString()}), not as it stood during the week. Usage rows carry no overflow marker; the share is derived from where attempts landed.`,
    },
    {
      code: "coverage",
      text: `Covers ${start} to ${end} UTC (end exclusive), generated ${period.generatedAt.toISOString()}. Usage written after generation is not included, and a stored report is never regenerated.`,
    },
    {
      code: "dating",
      text: "Requests are dated by the instant they settled; attempts by the instant they started. A request that started in this week and settled after it is counted in the next week, while its attempts stay in this one.",
    },
    {
      code: "settle_margin",
      text: coverage.settleCoversUpstreamTimeout
        ? `Generated ${coverage.generatedAfterPeriodEndMinutes} minutes after the week boundary, past the ${timeoutMinutes} minute upstream timeout, so attempts in flight at the boundary had landed.`
        : `Generated ${coverage.generatedAfterPeriodEndMinutes} minutes after the week boundary, within the ${timeoutMinutes} minute upstream timeout: an attempt still in flight at the boundary can land after generation and ${
            // A preview stores nothing, so nothing is lost yet — the loss is the stored report's.
            period.preview ? "would be missed in a stored report" : "is missed for good"
          }.`,
    },
  ]
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`
}
