import type { Dialect } from "@multi-ai-router/core"
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
  /**
   * The client's own `x-request-id`, when it sent one that is not already a UUID. Null when the
   * router minted the id. It is a trace label, never the join key — see `clientRequestIdFrom`.
   */
  readonly clientRequestId: string | null
  /** Which ingress surface the client called. Fixed per route, never sniffed from the body. */
  readonly ingressDialect: Dialect
  /** Monotonic reading taken the instant the request entered the router. */
  readonly requestStarted: number
}

export type AttemptAttribution = Omit<
  AttemptRecordInput,
  "tokens" | "timing" | "outcome" | "streamed" | "httpStatus" | "errorClass"
>

export interface DispatchRuntime extends RuntimeInput {
  attribution(attempt: number, servable: ServableCandidate): AttemptAttribution
  /**
   * Router overhead is total router time minus time spent waiting on upstreams.
   *
   * `firstByteAt` is a monotonic reading taken when the first byte was relayed, or undefined when
   * none was. Undefined records as NULL, never as zero: a TTFB of 0 ms is a claim nobody measured.
   */
  timing(
    startedAt: Date,
    attemptStarted: number,
    upstreamMs: number,
    firstByteAt?: number,
  ): AttemptTiming
  /** The attribution for a failure that happened before any account was selected. */
  preflightAttribution(): AttemptAttribution
}

export function createRuntime(input: RuntimeInput): DispatchRuntime {
  const shared = {
    correlationId: input.correlationId,
    clientRequestId: input.clientRequestId,
    apiKeyId: input.apiKeyId,
    sessionKey: input.sessionKey,
    model: input.model,
    ingressDialect: input.ingressDialect,
  }

  return {
    ...input,

    attribution: (attempt, servable) => ({
      ...shared,
      attempt,
      accountId: servable.account.id,
      // The pool whose policy ordered this account. Not recoverable by a later join: an account
      // sits in many pools and membership changes, so which one was in play is a fact about the
      // request, not about the account.
      poolId: servable.candidate.poolId,
      provider: servable.account.driver.provider,
      upstreamModel: servable.upstreamModel,
      egressMode: servable.egressMode,
    }),

    preflightAttribution: () => ({
      ...shared,
      attempt: 1,
      // No account was selected, so there is no pool and no egress path. Null is the honest
      // value here, not a default standing in for one.
      accountId: null,
      poolId: null,
      provider: null,
      upstreamModel: input.model,
      egressMode: null,
    }),

    timing: (startedAt, attemptStarted, upstreamMs, firstByteAt) => {
      const elapsed = input.clock.elapsed()
      return {
        startedAt,
        finishedAt: input.clock.now(),
        latencyMs: elapsed - attemptStarted,
        totalMs: elapsed - input.requestStarted,
        upstreamMs,
        // Measured from when the request entered the router, not from when this attempt began:
        // what the client experiences includes every failover that preceded the byte.
        ...(firstByteAt === undefined ? {} : { ttfbMs: firstByteAt - input.requestStarted }),
      }
    },
  }
}
