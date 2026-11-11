import type { AttemptFailure } from "../routing"
import type { UsageRecord } from "../usage"
import type { AttemptOutcome, UpstreamError } from "./attempt"
import { logAttemptFailure } from "./attempt-log"
import type { ChainContext } from "./chain"
import { answeredFailure, type ChainFailure, foldChainFailure } from "./chain-error"
import type { AttemptClock, AttemptRelay } from "./chain-relay"
import { DEFAULT_LOG_REASON_MAX_CHARS } from "./dispatcher-config"
import type { ServableCandidate } from "./plan"
import { attemptRecord, failureOutcome } from "./records"

/** Preserve the most actionable provider verdict while recording every failed attempt. */
export function finishFailedAttempt(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  outcome: Extract<AttemptOutcome, { kind: "failure" }>,
  at: AttemptClock,
  held: ChainFailure | null,
): ChainFailure | null {
  const { runtime } = ctx
  const winner = recordAttemptFailure(
    ctx,
    servable,
    attempt,
    outcome.failure,
    outcome.upstream,
    at,
    outcome.errorClass ?? null,
    outcome.answeredStatus ?? outcome.upstream?.status ?? null,
  )
  logAttemptFailure(
    ctx.log,
    servable.account.id,
    attempt,
    outcome,
    ctx.reasonMaxChars ?? DEFAULT_LOG_REASON_MAX_CHARS,
  )
  const failure = answeredFailure(
    outcome.classification,
    outcome.upstream,
    servable.translation === null ? null : runtime.ingressDialect,
    {
      rateLimit: outcome.rateLimit,
      now: runtime.clock.now(),
      ...(runtime.unknownResetRetryAfterSeconds === undefined
        ? {}
        : { unknownResetRetryAfterSeconds: runtime.unknownResetRetryAfterSeconds }),
      clientMessage: outcome.failure.message,
      failureKind: outcome.failure.kind,
      ...(outcome.verdict === undefined ? {} : { verdict: outcome.verdict }),
    },
  )
  return foldChainFailure(held, failure === null ? null : { ...failure, winner })
}

export function recordAttemptFailure(
  ctx: AttemptRelay,
  servable: ServableCandidate,
  attempt: number,
  failure: AttemptFailure,
  upstream: UpstreamError | null,
  at: AttemptClock,
  errorClass: string | null = null,
  /** The upstream's own status; differs from `upstream.status` only for a wall read out of a 2xx. */
  httpStatus: number | null = upstream?.status ?? null,
): UsageRecord {
  const event = attemptRecord({
    ...ctx.runtime.attribution(attempt, servable),
    // Same rule on the way down: a count that never landed is no more priceable than one that did.
    priced: ctx.runtime.operation !== "count-tokens",
    timing: ctx.runtime.timing(at.startedAt, at.started, at.upstreamMs),
    outcome: failureOutcome(failure.kind),
    streamed: false,
    httpStatus,
    errorClass,
  })
  ctx.runtime.record(event)
  return event
}
