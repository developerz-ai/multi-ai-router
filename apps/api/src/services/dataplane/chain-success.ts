import { accountLevelReading } from "../../providers"
import type { AttemptOutcome } from "./attempt"
import type { attemptQuota } from "./attempt-quota"
import type { ChainContext } from "./chain"
import { relaySuccess, type SuccessClock } from "./chain-relay"
import type { ServableCandidate } from "./plan"
import { decidedTranslation } from "./relay-translate-held"
import { droppedParamsHeaders, servedByHeaders, withHeaders } from "./router-headers"
import { withSessionRestart } from "./session-restart"

/** Whether this answer arrived rate limited: a live SDK observer says so late, an HTTP head at once. */
export function rateEvidence(
  quota: ReturnType<typeof attemptQuota> | undefined,
  outcome: Extract<AttemptOutcome, { kind: "success" }>,
): Pick<SuccessClock, "rateLimited" | "isRateLimited" | "onSettled"> {
  const limited = outcome.rateLimit?.limited ?? false
  if (quota === undefined) return { rateLimited: limited }
  return { isRateLimited: () => quota.limited() || limited, onSettled: quota.close }
}

/** Header evidence, the served-by headers and session restart framing precede body settlement. */
export function finishSuccessfulAttempt(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  outcome: Extract<AttemptOutcome, { kind: "success" }>,
  at: SuccessClock,
  /** Why this turn may have lost its bound session, or undefined when it never had one to lose. */
  restart: string | undefined,
): Promise<Response> | Response {
  // The model served: a run of these steps its throttle hold down (`health-model-holds.ts`).
  ctx.runtime.health.modelServed(
    servable.account.id,
    servable.upstreamModel,
    ctx.runtime.clock.now(),
  )
  if (servable.kind !== "sdk")
    ctx.runtime.health.applyRateLimit(
      servable.account.id,
      // A limit on this model alone is not the account's (`rate-limit/scope.ts`).
      accountLevelReading(outcome.rateLimit, {
        driver: servable.driver,
        upstreamModel: servable.upstreamModel,
      }),
      ctx.runtime.clock.now(),
      at.observation,
    )
  const answer = relaySuccess(ctx, servable, attempt, outcome.response, at)
  // A held translation decides its status before anything is committed (`relay-translate-held.ts`).
  const held = decidedTranslation(answer)
  if (held !== undefined)
    return held.then((decided) => stamp(ctx, servable, attempt, outcome, decided, restart))
  return stamp(ctx, servable, attempt, outcome, answer, restart)
}

function stamp(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  outcome: Extract<AttemptOutcome, { kind: "success" }>,
  answer: Response,
  restart: string | undefined,
): Response {
  // The attempt count is the dispatcher's, the one source for success and failure alike.
  const relayed = withHeaders(answer, {
    ...servedByHeaders({
      accountId: servable.account.id,
      provider: servable.account.driver.provider,
      upstreamModel: servable.upstreamModel,
    }),
    ...(servable.translation === null
      ? {}
      : droppedParamsHeaders(
          ctx.translated.surfaceDropped(servable.translation, servable.responsesEgress),
        )),
  })
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
