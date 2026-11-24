import type { AttemptRelay, SuccessClock } from "./chain-relay-types"
import { breakerOptionsFor } from "./health"
import type { ServableCandidate } from "./plan"
import type { RelayVerdict } from "./relay-terminal"

/**
 * What one relayed answer does to its account's health, in two steps.
 *
 * A recovering account is proved by its first model output, not by the end of the stream: the
 * designated request held the account's one permit, and every other request was refused, for as long
 * as that generation ran (minutes). So a probe settles at that point and the account rejoins the
 * rotation. How the stream ends still reaches the breaker.
 */
export function createRelayHealth(
  ctx: Pick<AttemptRelay, "runtime">,
  servable: ServableCandidate,
  at: SuccessClock,
) {
  const { health, clock } = ctx.runtime
  const accountId = servable.account.id
  const probing = servable.candidate.halfOpen || at.recovery?.designated === true
  let committed = false
  const rateLimited = (): boolean => at.isRateLimited?.() ?? at.rateLimited ?? false
  return {
    /** The first model output is on its way to the client. */
    firstOutput(): void {
      if (!probing || committed || rateLimited()) return
      committed = true
      at.recovery?.finish("succeeded")
      health.recordSuccess(accountId, at.observation)
      at.releaseProbe?.()
    },
    settle(verdict: RelayVerdict): void {
      const limited = rateLimited()
      if (!committed) at.recovery?.finish(limited ? "failed" : verdict.recovery)
      if (verdict.failure !== null && verdict.recovery !== "succeeded") {
        const observation =
          committed && at.observation !== undefined
            ? (health.followAttempt?.(accountId, at.observation) ?? at.observation)
            : at.observation
        health.recordFailure(
          accountId,
          { ...verdict.failure, message: "upstream response stream failed" },
          clock.now(),
          {
            ...breakerOptionsFor(servable.driver.authKind),
            recoveryProbe: !committed && at.recovery?.designated === true,
          },
          observation,
        )
      } else if (verdict.recovery === "succeeded" && !limited && !committed) {
        // A clean finish, a client cancel after the model already produced output, or a refusal of
        // the request itself.
        health.recordSuccess(accountId, at.observation)
      }
      if (verdict.failure?.kind === "model-unsupported")
        health.refuseModel(accountId, servable.upstreamModel, clock.now())
    },
  }
}
