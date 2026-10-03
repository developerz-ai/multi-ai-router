import type { AttemptOutcome } from "./attempt"
import type { ChainContext } from "./chain"
import { breakerOptionsFor } from "./health"
import type { HealthObservation } from "./health-observation"
import type { ServableCandidate } from "./plan"
import type { RecoveryAttempt } from "./recovery-access"

/** Failure verdict precedes quota readings; a recovered account cannot erase billing exhaustion. */
export function recordChainFailure(
  ctx: ChainContext,
  servable: ServableCandidate,
  outcome: Extract<AttemptOutcome, { kind: "failure" }>,
  now: Date,
  observation: HealthObservation,
  recovery: RecoveryAttempt | undefined,
) {
  // SDK preparation can fail before the final start guard consumes any provider authority.
  if (recovery !== undefined && !recovery.started()) return
  ctx.runtime.health.recordFailure(
    servable.account.id,
    outcome.failure,
    now,
    {
      ...breakerOptionsFor(servable.driver.authKind),
      recoveryProbe: recovery?.designated ?? servable.candidate.halfOpen,
    },
    observation,
  )
  recovery?.finish("failed")
  ctx.runtime.health.applyRateLimit(servable.account.id, outcome.rateLimit, now, observation)
}
