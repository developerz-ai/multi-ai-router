import { readErrorFacts } from "../failure/error-body"
import type { RateLimitSignal, UpstreamResponse } from "../types"
import { parseRateLimitHeaders } from "./parse"

/** Exact sanitized audit fixture only; response Date supplies its omitted year. */
export function compatibleBodyReset(response: UpstreamResponse): Date | undefined {
  if (response.status !== 429) return undefined
  const message = readErrorFacts(response.body).message
  const match = message?.match(
    /quota (?:has been )?exhausted\. The quota will reset at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC\./i,
  )
  const reference = response.headers.get("date")
  if (!match || !reference) return undefined
  const referenceMs = Date.parse(reference)
  if (!Number.isFinite(referenceMs)) return undefined
  const year = new Date(referenceMs).getUTCFullYear()
  const suffix = `${match[1]}-${match[2]}T${match[3]}:${match[4]}:${match[5]}Z`
  for (const candidateYear of [year, year + 1]) {
    const value = new Date(`${candidateYear}-${suffix}`)
    // Reject date normalization and implausible annual reset guesses.
    if (
      !Number.isFinite(value.getTime()) ||
      value.toISOString().slice(0, 19) !== `${candidateYear}-${suffix.slice(0, -1)}`
    )
      continue
    const delta = value.getTime() - referenceMs
    if (delta >= 0 && delta <= 31 * 86400000) return value
  }
  return undefined
}

export function parseCompatibleRateLimit(response: UpstreamResponse): RateLimitSignal | null {
  const parsed = parseRateLimitHeaders(response)
  if (parsed?.resetsAt !== undefined || parsed?.retryAfterSeconds !== undefined) return parsed
  const resetsAt = compatibleBodyReset(response)
  return resetsAt === undefined
    ? parsed
    : { limited: true, resetSource: "provider-reported", windows: parsed?.windows ?? [], resetsAt }
}
