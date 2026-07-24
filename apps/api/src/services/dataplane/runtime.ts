import type { CredentialCipher } from "../crypto/cipher"
import type { UsageRecord } from "../usage"
import type { HealthStore } from "./health"
import type { ServableCandidate } from "./plan"
import type { AttemptRecordInput, AttemptTiming } from "./records"
import type { DataPlaneClock, FetchLike } from "./types"

/**
 * Everything one client request carries through its failover chain, bundled once.
 *
 * It exists so the chain reads as the sequence of decisions it is, rather than as a function
 * threading eleven arguments. The attribution and timing helpers live here because every attempt
 * of one request shares the same key, session, model, and correlation id — computing them per
 * attempt would be the same values assembled again, with one more place to get them wrong.
 */

export interface RuntimeInput {
  readonly health: HealthStore
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly call: FetchLike
  readonly clock: DataPlaneClock
  readonly timeoutMs: number
  readonly record: (record: UsageRecord) => void
  /** Correlation id shared by every attempt of this request. */
  readonly correlationId: string
  readonly apiKeyId: string
  readonly sessionKey: string
  /** Exactly what the client asked for. Never substituted. */
  readonly model: string
  /** Monotonic reading taken the instant the request entered the router. */
  readonly requestStarted: number
}

export type AttemptAttribution = Omit<
  AttemptRecordInput,
  "tokens" | "timing" | "outcome" | "streamed" | "httpStatus" | "errorClass"
>

export interface DispatchRuntime extends RuntimeInput {
  attribution(attempt: number, servable: ServableCandidate): AttemptAttribution
  /** Router overhead is total router time minus time spent waiting on upstreams. */
  timing(startedAt: Date, attemptStarted: number, upstreamMs: number): AttemptTiming
  /** The attribution for a failure that happened before any account was selected. */
  preflightAttribution(): AttemptAttribution
}

export function createRuntime(input: RuntimeInput): DispatchRuntime {
  const shared = {
    correlationId: input.correlationId,
    apiKeyId: input.apiKeyId,
    sessionKey: input.sessionKey,
    model: input.model,
  }

  return {
    ...input,

    attribution: (attempt, servable) => ({
      ...shared,
      attempt,
      accountId: servable.account.id,
      provider: servable.account.driver.provider,
      upstreamModel: servable.upstreamModel,
    }),

    preflightAttribution: () => ({
      ...shared,
      attempt: 1,
      accountId: null,
      provider: null,
      upstreamModel: input.model,
    }),

    timing: (startedAt, attemptStarted, upstreamMs) => {
      const elapsed = input.clock.elapsed()
      return {
        startedAt,
        finishedAt: input.clock.now(),
        latencyMs: elapsed - attemptStarted,
        totalMs: elapsed - input.requestStarted,
        upstreamMs,
      }
    },
  }
}
