import type { AttemptOutcome } from "./attempt"
import type { ChainContext } from "./chain"
import { relaySuccess, type SuccessClock } from "./chain-relay"
import type { ServableCandidate } from "./plan"
import { servedByHeaders, withHeaders } from "./router-headers"
import { withSessionRestart } from "./session-restart"

/** Header evidence, the served-by headers and session restart framing precede body settlement. */
export function finishSuccessfulAttempt(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  outcome: Extract<AttemptOutcome, { kind: "success" }>,
  at: SuccessClock,
  /** Why this turn may have lost its bound session, or undefined when it never had one to lose. */
  restart: string | undefined,
): Response {
  if (servable.kind !== "sdk")
    ctx.runtime.health.applyRateLimit(
      servable.account.id,
      outcome.rateLimit,
      ctx.runtime.clock.now(),
      at.observation,
    )
  // The attempt count is the dispatcher's, the one source for success and failure alike.
  const relayed = withHeaders(
    relaySuccess(ctx, servable, attempt, outcome.response, at),
    servedByHeaders({
      accountId: servable.account.id,
      provider: servable.account.driver.provider,
      upstreamModel: servable.upstreamModel,
    }),
  )
  if (restart === undefined) return relayed
  // The transcript followed the turn to this account (`claude-sdk/session-carry.ts`): the upstream
  // conversation is intact, so there is no restart to surface.
  if (outcome.sessionCarried === true) {
    ctx.log?.info("bound session carried to another account", {
      accountId: servable.account.id,
      attempt,
      reason: restart,
    })
    return relayed
  }
  ctx.log?.warn("bound session restarted on another account", {
    accountId: servable.account.id,
    attempt,
    reason: restart,
  })
  return withSessionRestart(relayed, restart)
}
