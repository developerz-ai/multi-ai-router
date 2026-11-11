import type { ResponseObservationFacts } from "./response-observer-types"

/**
 * Why a relayed response's token counts are no measurement, or null when they are one.
 *
 * Zero token columns can mean two things. Either the upstream measured nothing, or it never stated
 * a count the observer could read. Only the first is a free completion, so the record has to tell
 * them apart: a row whose usage was never read keeps the zeros (nothing was measured), prices as
 * `unknown`, and carries one of these names in `errorClass`
 * (docs/idea/06-protocol-translation.md, "Absent, never zero").
 *
 * - `usage_invalid`: a usage block arrived and the reader could not trust it, for example a cached
 *   count larger than the input it is part of.
 * - `usage_unobservable`: the observer lost evidence (an unparseable frame, or a body it could
 *   not read) and no usage sample was read before or after.
 * - `usage_unreported`: the stream was readable and stated no usage. That covers a stream that
 *   ended without its final event and a final event without a `usage` member.
 *
 * Only consulted when no sample was read. A response with a stated sample keeps its counts and its
 * price as before, even when a later frame was unreadable.
 */
export type UsageUnread = "usage_invalid" | "usage_unobservable" | "usage_unreported"

export function usageUnread(
  facts: Pick<ResponseObservationFacts, "usageStated" | "usageInvalid" | "evidenceUnavailable">,
): UsageUnread | null {
  if (facts.usageStated) return null
  if (facts.usageInvalid) return "usage_invalid"
  if (facts.evidenceUnavailable) return "usage_unobservable"
  return "usage_unreported"
}
