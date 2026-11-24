import { z } from "zod"
import { parseInstant } from "../rate-limit/duration"

/**
 * A Gemini `429` for a spent **day**. Sibling of `gemini.ts`. Pure: the instant comes off the reply's
 * own `Date`.
 *
 * Provenance: `google.rpc.QuotaFailure` in `error.details[]` names the allowance in
 * `violations[].quotaId` (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`); and
 * aistudio.google.com/docs/rate-limits: "Requests per day (RPD) quotas reset at midnight Pacific
 * time". The `RetryInfo` beside it is a pacing hint (`31s`, discuss.ai.google.dev/t/96899), so
 * following it would re-ask a key every half minute until midnight. Computed rather than stated, so it is labelled `estimated`. Blast
 * radius: how long a spent Gemini model is passed over.
 */
const PER_DAY = /PerDay/
const QUOTA_FAILURE_TYPE = "google.rpc.QuotaFailure"
const RESET_ZONE = "America/Los_Angeles"

const QuotaFailure = z.object({
  "@type": z.string(),
  violations: z.array(z.looseObject({ quotaId: z.string().optional().catch(undefined) })),
})

export function isDailyAllowance(details: readonly unknown[]): boolean {
  return details.some((detail) => {
    const failure = QuotaFailure.safeParse(detail)
    return (
      failure.success &&
      failure.data["@type"].endsWith(QUOTA_FAILURE_TYPE) &&
      failure.data.violations.some(({ quotaId }) => quotaId !== undefined && PER_DAY.test(quotaId))
    )
  })
}

/** The next midnight Pacific after the reply, or `null` when the reply states no usable `Date`. */
export function dailyAllowanceReset(headers: Headers): Date | null {
  const date = headers.get("date")
  const at = date === null ? null : parseInstant(date)
  if (at === null) return null
  const { year, month, day } = pacific(at)
  // Midnight of the next Pacific day, if it is standard time (UTC-8); an hour later in summer time.
  const standard = new Date(Date.UTC(year, month - 1, day + 1, 8))
  return pacific(standard).hour === 0 ? standard : new Date(standard.getTime() - 3_600_000)
}

const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: RESET_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
})

function pacific(at: Date): { year: number; month: number; day: number; hour: number } {
  const part = Object.fromEntries(
    PACIFIC.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  )
  return {
    year: part.year ?? Number.NaN,
    month: part.month ?? Number.NaN,
    day: part.day ?? Number.NaN,
    hour: part.hour ?? Number.NaN,
  }
}
