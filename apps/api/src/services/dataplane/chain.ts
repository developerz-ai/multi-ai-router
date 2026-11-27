import { isRouterError } from "@multi-ai-router/core"
import {
  type AttemptFailure,
  type Candidate,
  type FailureKind,
  inPlaceReason,
  isUnstartedVerdict,
  NO_ATTEMPTS,
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
import {
  logAwaitingPermit,
  logCandidateDropped,
  logPreparationThrew,
  logUnstartedDrop,
} from "./chain-drop-log"
import { type ChainFailure, foldChainFailure, routerFailure } from "./chain-error"
import { finishFailedAttempt, noteFailure } from "./chain-failed-attempt"
import { finishChain } from "./chain-finish"
import { invalidPreparation, recordUnrepresentable } from "./chain-preparation"
import { recordChainFailure } from "./chain-recovery"
import { createChainRefusals } from "./chain-refusals"
import { finishSuccessfulAttempt, rateEvidence } from "./chain-success"
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
 * response and never re-enters the loop.
 *
 * Attempts are bounded, each one a distinct account — except the single in-place replay a stale SDK
 * session earns — and every one writes its own `UsageRecord`, sharing the request's correlation id.
 *
 * When several attempts fail, the one the client hears about is the **most actionable**, not the
 * last: `chain-error.ts` ranks them, so a broken account late in the chain cannot bury the honest
 * answer an account earlier in it already gave.
 *
 * A candidate the breaker offered as a half-open probe is admitted one at a time (`probe.ts`). A
 * refusal drops it from this chain's list — no attempt, no record — as another request spends it.
 */

export type { ChainContext } from "./chain-context"

export async function runChain(ctx: ChainContext): Promise<Response> {
  // Mutable: a half-open candidate another request is already probing is dropped from the plan.
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
      const before = runtime.clock.elapsed()
      await pause(decision.delayMs, ctx.request.signal)
      runtime.onWaited?.(Math.max(0, runtime.clock.elapsed() - before))
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
      refusals.record(accountId)
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
    // Its start guard would refuse it: drop it before a body or a turn is prepared for nothing.
    if (recovery?.awaitsPermit?.() === true) {
      probe.release()
      refusals.record(accountId)
      ordered = ordered.filter((candidate) => candidate.account.id !== accountId)
      logAwaitingPermit(ctx.log, runtime, accountId, decision.attempt)
      continue
    }
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
    const lifetime = attemptLifetime(
      runtime,
      servable,
      decision.attempt,
      at,
      runtime.clock.elapsed(),
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

    // A request-attributable refusal or a full gate is a verdict even unstarted: failure tail.
    const verdict = outcome.kind === "failure" && isUnstartedVerdict(outcome.failure)
    if (
      outcome.kind === "admission-refused" ||
      (outcome.kind === "failure" && !lifetime.started() && !verdict)
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
      if (outcome.kind === "admission-refused") refusals.record(accountId)
      else refusals.recordPreparation()
      logUnstartedDrop(ctx.log, accountId, decision.attempt, outcome)
      continue
    }

    if (ctx.request.signal.aborted && (outcome.kind === "success" || isCancelledOutcome(outcome))) {
      quota?.close()
      recovery?.finish("uncertain")
      lifetime.end()
      probe.release()
      upstreamMs += runtime.clock.elapsed() - lifetime.opened()
      return cancelledBeforeRelay(runtime, servable, decision.attempt, outcome, {
        ...at,
        upstreamMs,
      })
    }

    if (outcome.kind === "success") {
      // Relay settlement closes the upstream span after the last byte.
      return finishSuccessfulAttempt(
        ctx,
        servable,
        decision.attempt,
        outcome,
        {
          ...at,
          upstreamStarted: lifetime.opened(),
          observation,
          ...forcedToolOn(servable, upstreamBody),
          releaseProbe: probe.release,
          ...rateEvidence(quota, outcome),
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
    upstreamMs += runtime.clock.elapsed() - lifetime.opened()

    lastFailure = outcome.failure
    failureKinds.push(outcome.failure.kind)
    progress = noteFailure(progress, servable, outcome.failure)
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
    capacityRetryAfterSeconds: capacityRetryAfterSeconds(
      runtime,
      failureKinds,
      progress.attemptedAccountIds,
    ),
  })
}
