import {
  type AttemptFailure,
  type FailoverProgress,
  noteOverload,
  noteProviderScoped,
  noteRequestAttributable,
} from "../routing"
import type { UsageRecord } from "../usage"
import type { AttemptOutcome, UpstreamError } from "./attempt"
import { logAttemptFailure } from "./attempt-log"
import type { ChainContext } from "./chain"
import { answeredFailure, type ChainFailure, foldChainFailure } from "./chain-error"
import type { AttemptClock, AttemptRelay } from "./chain-relay"
import { DEFAULT_LOG_REASON_MAX_CHARS } from "./dispatcher-config"
import type { ServableCandidate } from "./plan"
import { attemptRecord, failureOutcome } from "./records"
import { HOOK_SIGNAL } from "./relay-terminal"

/** What one failed attempt teaches the planner about the rest of this chain. */
export function noteFailure(
  progress: FailoverProgress,
  servable: ServableCandidate,
  failure: AttemptFailure,
): FailoverProgress {
  const { account } = servable
  const attributed = noteRequestAttributable(progress, failure)
  const scoped = noteProviderScoped(attributed, account.driver.provider, failure)
  return noteOverload(scoped, account.id, failure.kind)
}

/**
 * A refusal of the request itself keeps the signal that says so as its row's class: booked under the
 * outcome alone it read as a spent account (`quota_exhausted`, prod 2026-11-23, 1058 rows).
 */
function attributableClass(outcome: Extract<AttemptOutcome, { kind: "failure" }>): string | null {
  if (outcome.failure.requestAttributable !== true) return null
  const signal = outcome.classification?.signal ?? outcome.upstreamSignal
  return signal !== undefined && HOOK_SIGNAL.test(signal) ? signal : null
}

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
    outcome.errorClass ?? attributableClass(outcome),
    outcome.answeredStatus ?? outcome.upstream?.status ?? null,
  )
  logAttemptFailure(
    ctx.log,
    servable.account.id,
    attempt,
    outcome,
    ctx.reasonMaxChars ?? DEFAULT_LOG_REASON_MAX_CHARS,
  )
  const now = runtime.clock.now()
  // The same verified, fresh spend_limit reset the breaker already used to cool this refusal, asked
  // of this refusal: one that names the key's cap borrows from a near-spent cap, one that names
  // nothing only from a fully spent one (`routing/plan-reset.ts`, `keyCapResetFor`). Read once;
  // absent evidence yields null and leaves the client's credits-exhausted answer untouched.
  const keyCapResetsAt = runtime.health.keyCapResetAt(servable.account.id, now, outcome.failure)
  const failure = answeredFailure(
    outcome.classification,
    outcome.upstream,
    servable.translation === null ? null : runtime.ingressDialect,
    {
      rateLimit: outcome.rateLimit,
      now,
      ...(keyCapResetsAt === undefined || keyCapResetsAt === null ? {} : { keyCapResetsAt }),
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
