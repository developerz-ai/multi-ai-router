import type { AttemptOutcome } from "./attempt"
import { logAttemptFailure } from "./attempt-log"
import type { ChainContext } from "./chain"
import { answeredFailure, type ChainFailure, foldChainFailure } from "./chain-error"
import { type AttemptClock, recordAttemptFailure } from "./chain-relay"
import { DEFAULT_LOG_REASON_MAX_CHARS } from "./dispatcher-config"
import type { ServableCandidate } from "./plan"

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
  recordAttemptFailure(ctx, servable, attempt, outcome.failure, outcome.upstream, at)
  logAttemptFailure(
    ctx.log,
    servable.account.id,
    attempt,
    outcome,
    ctx.reasonMaxChars ?? DEFAULT_LOG_REASON_MAX_CHARS,
  )
  return foldChainFailure(
    held,
    answeredFailure(
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
      },
    ),
  )
}
