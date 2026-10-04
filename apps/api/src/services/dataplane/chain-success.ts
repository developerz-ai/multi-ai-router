import type { AttemptOutcome } from "./attempt"
import type { ChainContext } from "./chain"
import { relaySuccess, type SuccessClock } from "./chain-relay"
import type { ServableCandidate } from "./plan"
import { withSessionRestart } from "./session-restart"

/** Header evidence and session restart framing precede terminal body settlement. */
export function finishSuccessfulAttempt(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  outcome: Extract<AttemptOutcome, { kind: "success" }>,
  at: SuccessClock,
  sessionRestart: boolean,
): Response {
  if (servable.kind !== "sdk")
    ctx.runtime.health.applyRateLimit(
      servable.account.id,
      outcome.rateLimit,
      ctx.runtime.clock.now(),
      at.observation,
    )
  const relayed = relaySuccess(ctx, servable, attempt, outcome.response, at)
  if (!sessionRestart) return relayed
  ctx.log?.warn("bound session restarted on another account", {
    accountId: servable.account.id,
    attempt,
  })
  return withSessionRestart(relayed, "failover")
}
