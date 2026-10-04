import type { QuotaWindowState } from "@multi-ai-router/core"
import { mergeQuotaWindows } from "../routing/quota"
import { type HealthObservation, newerObservation, sameAccountFacts } from "./health-observation"

export interface PendingQuotaReading {
  readonly windows: readonly QuotaWindowState[]
  readonly observation?: HealthObservation
}
/** Never re-label an old intent's quota as evidence belonging to the replacement intent. */
export function mergePendingQuota(
  held: PendingQuotaReading | undefined,
  incoming: PendingQuotaReading,
): PendingQuotaReading {
  if (held === undefined) return incoming
  const left = held.observation,
    right = incoming.observation
  if (
    (left === undefined && right === undefined) ||
    (left !== undefined &&
      right !== undefined &&
      left.observationGeneration === right.observationGeneration &&
      sameAccountFacts(left, right))
  )
    return { ...incoming, windows: mergeQuotaWindows(held.windows, incoming.windows) }
  if (left !== undefined && right !== undefined && !newerObservation(right, left)) return held
  return incoming
}
