import { isRouterError } from "@multi-ai-router/core"
import {
  type AttemptFailure,
  type Candidate,
  type FailureKind,
  inPlaceReason,
  markStreamed,
  NO_ATTEMPTS,
  noteOverload,
  noteRequestAttributable,
  planNextAttempt,
  recordAttempt,
} from "../routing"
import type { AttemptOutcome } from "./attempt"
import { thrownAttemptFailure } from "./attempt-failure"
import { attemptLifetime } from "./attempt-lifetime"
import { attemptQuota } from "./attempt-quota"
import { bodyFor } from "./chain-body"
import {
  assertUnstartedCancellation,
  cancelledBeforeRelay,
  isCancelledOutcome,
} from "./chain-cancellation"
import { capacityRetryAfterSeconds } from "./chain-capacity"
import type { ChainContext } from "./chain-context"
import { logCandidateDropped, logPreparationThrew, logUnstartedDrop } from "./chain-drop-log"
import { type ChainFailure, foldChainFailure, routerFailure } from "./chain-error"
import { finishFailedAttempt } from "./chain-failed-attempt"
import { finishChain } from "./chain-finish"
import { invalidPreparation, recordUnrepresentable } from "./chain-preparation"
import { recordChainFailure } from "./chain-recovery"
import { createChainRefusals } from "./chain-refusals"
import { finishSuccessfulAttempt } from "./chain-success"
import { dispatch } from "./dispatch"
import { forcedToolOn } from "./forced-tool-coercion"
import { accountHealthFacts } from "./health-observation"
import { pause } from "./pause"
import { admitHalfOpenProbe } from "./probe"
import { ClientCancelledError } from "./relay-cancellation"

/**
 * The failover chain: dispatch to the head, advance on a retryable failure, stop honestly.
 * **Once any byte has been written to the client, failover is over.** That is enforced by
 * structure, not by a flag someone has to remember to check: the success branch returns the relayed
 * response and never re-enters the loop. `markStreamed` records the same fact for the failover
 * planner, which refuses every retry from that point on.
 *
 * Attempts are bounded, each one a distinct account — except the single in-place replay a stale SDK
 * session earns — and every one writes its own `UsageRecord`, sharing the request's correlation id.
 *
 * When several attempts fail, the one the client hears about is the **most actionable**, not the
 * last: `chain-error.ts` ranks them, so a broken account late in the chain cannot bury the honest
 * answer an account earlier in it already gave.
 *
 * A candidate the breaker offered as a half-open probe is admitted one at a time (`probe.ts`). A
 * refusal drops it from this chain's candidate list — no attempt, no record, no upstream — because
 * another request is already spending the single probe that account earns.
 */

export type { ChainContext } from "./chain-context"

export async function runChain(ctx: ChainContext): Promise<Response> {
  // Mutable for one reason: a half-open candidate another request is already probing is removed, so
  // the planner walks past it instead of re-offering the same refusal forever.
  let ordered: readonly Candidate[] = ctx.plan.map((entry) => entry.candidate)
  const byId = new Map(ctx.plan.map((entry) => [entry.candidate.account.id, entry]))
  const { runtime } = ctx

  const refusals = createChainRefusals(ctx)
  let progress = NO_ATTEMPTS
  let lastFailure: AttemptFailure | null = null
  /** The most actionable failure any attempt has produced so far. See `chain-error.ts`. */
  let held: ChainFailure | null = null
  let upstreamMs = 0
  const failureKinds: FailureKind[] = []
  let requestWall = false

  for (;;) {
    if (ctx.request.signal.aborted) {
      runtime.activeRequest?.release()
      if (held !== null)
        return finishChain(held, lastFailure, refusals.failIfAny, runtime.selectTerminal)
      throw ctx.request.signal.reason ?? new ClientCancelledError()
    }
    const decision = planNextAttempt(ordered, progress, lastFailure, ctx.failover)
    if (decision.action === "stop") {
      requestWall = decision.reason === "request-wall"
      break
    }
    // An `overloaded` retry waits out the provider's busy backend first (`routing/failover.ts`).
    if (decision.action === "retry-in-place" && decision.delayMs !== undefined) {
      await pause(decision.delayMs, ctx.request.signal)
      if (ctx.request.signal.aborted) continue
    }

    const servable = byId.get(decision.candidate.account.id)
    if (servable === undefined) break

    const accountId = servable.account.id
    const observation = runtime.health.captureAttempt(
      accountId,
      accountHealthFacts(servable.account),
    )
    const attemptStartedAt = runtime.clock.now()

    // A refused probe is not an attempt; another request already owns recovery.
    const probe = admitHalfOpenProbe(runtime.health, decision.candidate, attemptStartedAt)
    if (!probe.admitted) {
      refusals.record()
      runtime.recovery?.hint(accountId, "cooldown-expired")
      ordered = ordered.filter((candidate) => candidate.account.id !== accountId)
      logCandidateDropped(ctx.log, accountId, decision.attempt, "half-open-probe-in-flight")
      continue
    }

    const priorProgress = progress
    const recovery = runtime.recovery?.prepare(
      servable.account,
      decision.candidate,
      runtime.quotaSpentThreshold,
    )
    progress = recordAttempt(progress, accountId, inPlaceReason(decision))

    const attemptStarted = runtime.clock.elapsed()
    const at = { startedAt: attemptStartedAt, started: attemptStarted, upstreamMs }

    // Reject an unrepresentable request before opening an upstream span.
    let upstreamBody: Uint8Array | null
    try {
      upstreamBody = bodyFor(ctx, servable)
    } catch (error) {
      probe.release()
      if (!isRouterError(error)) throw error
      held = foldChainFailure(held, routerFailure(error))
      lastFailure = { kind: "client-error", message: error.message }
      recordUnrepresentable(runtime, error, at)
      continue
    }

    // Conversion is router work; the upstream wait starts only after the body exists.
    const upstreamStarted = runtime.clock.elapsed()
    const lifetime = attemptLifetime(
      runtime,
      servable,
      decision.attempt,
      at,
      upstreamStarted,
      recovery,
      probe.release,
    )

    const quota =
      servable.kind === "sdk"
        ? attemptQuota(runtime, accountId, observation, lifetime.started, ctx.request.signal)
        : undefined
    let outcome: AttemptOutcome
    try {
      outcome = await dispatch(
        ctx,
        servable,
        upstreamBody,
        // A session replay, not an overload wait: only the former resumes differently on the SDK.
        inPlaceReason(decision) === "replay",
        recovery?.beforeUpstreamStart,
        lifetime.onStarted,
        quota,
      )
    } catch (error) {
      lifetime.assertRunning()
      // The upstream was contacted, then the router threw reading its answer: that is an attempt,
      // and it fails over through the same tail as any other failure (02.7). A router verdict
      // (a typed error) stays the router's own answer, as before.
      if (lifetime.started() && !ctx.request.signal.aborted && !isRouterError(error))
        outcome = thrownAttemptFailure(error)
      else {
        quota?.close()
        // Preparation has no upstream verdict and cannot outrank an earlier provider response.
        lifetime.end()
        if (recovery?.started()) recovery.finish("uncertain")
        probe.release()
        if (ctx.request.signal.aborted)
          throw ctx.request.signal.reason ?? new ClientCancelledError()
        held = foldChainFailure(held, isRouterError(error) ? routerFailure(error) : null)
        progress = priorProgress
        ordered = ordered.filter((candidate) => candidate.account.id !== accountId)
        refusals.recordPreparation()
        logPreparationThrew(ctx.log, accountId, decision.attempt, error)
        continue
      }
    }
    lifetime.assertRunning(outcome.kind === "success" ? outcome.response : undefined)
    assertUnstartedCancellation(outcome, lifetime.started(), ctx.request.signal)
    if (outcome.kind === "success") lifetime.onStarted()

    if (
      outcome.kind === "admission-refused" ||
      (outcome.kind === "failure" && !lifetime.started())
    ) {
      quota?.close()
      lifetime.end()
      if (recovery?.started()) recovery.finish("uncertain")
      probe.release()
      const invalid = invalidPreparation(runtime, outcome, at)
      if (invalid !== undefined) {
        held = foldChainFailure(held, routerFailure(invalid))
        lastFailure = { kind: "client-error", message: invalid.message }
        continue
      }
      progress = priorProgress
      ordered = ordered.filter((candidate) => candidate.account.id !== accountId)
      if (outcome.kind === "admission-refused") refusals.record()
      else refusals.recordPreparation()
      logUnstartedDrop(ctx.log, accountId, decision.attempt, outcome)
      continue
    }

    if (ctx.request.signal.aborted && (outcome.kind === "success" || isCancelledOutcome(outcome))) {
      quota?.close()
      recovery?.finish("uncertain")
      lifetime.end()
      probe.release()
      upstreamMs += runtime.clock.elapsed() - upstreamStarted
      return cancelledBeforeRelay(runtime, servable, decision.attempt, outcome, {
        ...at,
        upstreamMs,
      })
    }

    if (outcome.kind === "success") {
      progress = markStreamed(progress)
      // Relay settlement closes the upstream span after the last byte.
      return finishSuccessfulAttempt(
        ctx,
        servable,
        decision.attempt,
        outcome,
        {
          ...at,
          upstreamStarted,
          observation,
          ...forcedToolOn(servable, upstreamBody),
          releaseProbe: probe.release,
          ...(quota === undefined
            ? { rateLimited: outcome.rateLimit?.limited ?? false }
            : {
                isRateLimited: () => quota.limited() || (outcome.rateLimit?.limited ?? false),
                onSettled: quota.close,
              }),
          ...(recovery === undefined ? {} : { recovery }),
        },
        ctx.bindingRefused ??
          (decision.action === "attempt" && decision.sessionRestart ? "failover" : undefined),
      )
    }

    quota?.close()
    recordChainFailure(
      ctx,
      servable,
      outcome,
      runtime.clock.now(),
      observation,
      recovery,
      servable.kind !== "sdk",
    )
    if (recovery?.designated)
      ordered = ordered.filter((candidate) => candidate.account.id !== accountId)
    lifetime.end()
    // Release only after cooling the account, preventing another immediate probe.
    probe.release()
    upstreamMs += runtime.clock.elapsed() - upstreamStarted

    lastFailure = outcome.failure
    failureKinds.push(outcome.failure.kind)
    progress = noteRequestAttributable(progress, outcome.failure)
    progress = noteOverload(progress, accountId, outcome.failure.kind)
    held = finishFailedAttempt(
      ctx,
      servable,
      decision.attempt,
      outcome,
      { ...at, upstreamMs },
      held,
    )
  }

  runtime.activeRequest?.release()
  return finishChain(held, lastFailure, refusals.failIfAny, runtime.selectTerminal, {
    requestWall,
    capacityRetryAfterSeconds: capacityRetryAfterSeconds({
      kinds: failureKinds,
      triedAccountIds: progress.attemptedAccountIds,
      health: runtime.health,
      now: runtime.clock.now(),
      unknownResetRetryAfterSeconds: runtime.unknownResetRetryAfterSeconds,
    }),
  })
}
