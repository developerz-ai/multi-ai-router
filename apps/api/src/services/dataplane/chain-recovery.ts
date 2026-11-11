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
  applyQuota = true,
) {
  // SDK preparation can fail before the final start guard consumes any provider authority.
  if (recovery !== undefined && !recovery.started()) return

  // A `client-error` or `model-unsupported` is the upstream judging the *request*, not the account
  // (`routing/breaker.ts` leaves the breaker untouched for both). A designated recovery probe that
  // draws one has proved the account is answering, so record the probe as succeeded and the account
  // as healthy — never as a failed probe. Prod 2026-10-13..15: qwen's quota had reopened, but eight
  // forced-tool `400`s over two days were each recorded a failed recovery, re-gating the account
  // ~30s and drawing a router-made `429` with an eligible account in scope, until a non-forced
  // request finally succeeded on 10-15 20:36.
  // The account refused this model by name: keep that model off it for a while (10.16).
  if (outcome.failure.kind === "model-unsupported")
    ctx.runtime.health.refuseModel(servable.account.id, servable.upstreamModel, now)
  if (outcome.failure.kind === "client-error" || outcome.failure.kind === "model-unsupported") {
    recovery?.finish("succeeded")
    ctx.runtime.health.recordSuccess(servable.account.id, observation)
    return
  }

  // The provider's shared backend was busy: nothing about this account either way. No strike, no
  // limiter reading folded in (Go's overloaded `429` would otherwise cool the seat), and a
  // designated probe settles `uncertain` so its permit is not spent on someone else's outage.
  if (outcome.failure.kind === "overloaded") {
    recovery?.finish("uncertain")
    return
  }

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
  if (applyQuota)
    ctx.runtime.health.applyRateLimit(servable.account.id, outcome.rateLimit, now, observation)
}
