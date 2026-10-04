import type { ProviderId, UsageOutcome } from "@multi-ai-router/core"

/** Logical settlement carries no token or cost counters: those belong to attempts. */
export interface UsageRequestTerminal {
  readonly correlationId: string
  readonly winnerEventId: string | null
  readonly apiKeyId: string | null
  readonly accountId: string | null
  readonly poolId: string | null
  readonly provider: ProviderId | null
  readonly model: string | null
  readonly upstreamModel: string | null
  readonly outcome: UsageOutcome
  readonly errorClass: string | null
  readonly responseStatus: number | null
  readonly httpStatus: number | null
  readonly startedAt: Date
  readonly settledAt: Date
  readonly attributionKind: "winning-attempt" | "unstarted" | "abandoned"
}
