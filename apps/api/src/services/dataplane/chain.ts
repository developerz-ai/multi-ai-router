import { isRouterError } from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { ModelCatalogStore } from "../models/store"
import {
  type AttemptFailure,
  type Candidate,
  type FailoverOptions,
  markStreamed,
  NO_ATTEMPTS,
  planNextAttempt,
  recordAttempt,
} from "../routing"
import type { TranslationContext } from "../translate"
import type { AttemptOutcome } from "./attempt"
import { attemptLifetime } from "./attempt-lifetime"
import { attemptQuota } from "./attempt-quota"
import type { ByteSpan } from "./body/scanner"
import { bodyFor } from "./chain-body"
import {
  assertUnstartedCancellation,
  cancelledBeforeRelay,
  isCancelledOutcome,
} from "./chain-cancellation"
import { logCandidateDropped, logPreparationThrew, logUnstartedDrop } from "./chain-drop-log"
import { type ChainFailure, foldChainFailure, routerFailure } from "./chain-error"
import { finishFailedAttempt } from "./chain-failed-attempt"
import { finishChain } from "./chain-finish"
import { invalidPreparation } from "./chain-preparation"
import { recordChainFailure } from "./chain-recovery"
import { createChainRefusals } from "./chain-refusals"
import { finishSuccessfulAttempt } from "./chain-success"
import { dispatch } from "./dispatch"
import { accountHealthFacts } from "./health-observation"
import type { ServableCandidate } from "./plan"
import { admitHalfOpenProbe } from "./probe"
import { attemptRecord } from "./records"
import { ClientCancelledError } from "./relay-cancellation"
import type { DispatchRuntime } from "./runtime"
import type { TranslatedRequestBody } from "./translate-body"

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

export interface ChainContext {
  readonly modelMetadata?: Pick<ModelCatalogStore, "describe"> | undefined

  readonly runtime: DispatchRuntime
  readonly plan: readonly ServableCandidate[]
  /** The client's request: method, headers, and abort signal are taken from it. */
  readonly request: Request
  readonly bodyBytes: Uint8Array
  readonly modelSpan: ByteSpan | null
  /** The clock stamp, fallback ids, and configured ceiling every conversion of this request reads. */
  readonly translation: TranslationContext
  /** The converted upstream body, built lazily and only for a candidate that needs one. */
  readonly translated: TranslatedRequestBody
  readonly failover: FailoverOptions | undefined
  /**
   * Selection already refused this session's binding (`rebind` on a cooling account, out of scope,
   * exhausted, gone) — the reason, for the restart header a turn that could not carry the session
   * answers with (`session-restart.ts`).
   */
  readonly bindingRefused?: string
  readonly log: Logger | undefined
  /**
   * Ceiling on the upstream's own words quoted on a failed-attempt log line — `LOG_REASON_MAX_CHARS`,
   * threaded through `DispatchOptions.log`. Absent means {@link DEFAULT_LOG_REASON_MAX_CHARS}.
   */
  readonly reasonMaxChars?: number
}

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

  for (;;) {
    if (ctx.request.signal.aborted) {
      runtime.activeRequest?.release()
      if (held !== null)
        return finishChain(held, lastFailure, refusals.failIfAny, runtime.selectTerminal)
      throw ctx.request.signal.reason ?? new ClientCancelledError()
    }
    const decision = planNextAttempt(ordered, progress, lastFailure, ctx.failover)
    if (decision.action === "stop") break

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
    progress = recordAttempt(progress, accountId, decision.action === "retry-in-place")

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
      runtime.record(
        attemptRecord({
          ...runtime.preflightAttribution(),
          timing: runtime.timing(at.startedAt, at.started, upstreamMs),
          outcome: "client_error",
          streamed: false,
          httpStatus: null,
          errorClass: error.name,
        }),
      )
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
        decision.action === "retry-in-place",
        recovery?.beforeUpstreamStart,
        lifetime.onStarted,
        quota,
      )
    } catch (error) {
      quota?.close()
      lifetime.assertRunning()
      // Preparation has no upstream verdict and cannot outrank an earlier provider response.
      lifetime.end()
      probe.release()
      if (ctx.request.signal.aborted) throw ctx.request.signal.reason ?? new ClientCancelledError()
      held = foldChainFailure(held, isRouterError(error) ? routerFailure(error) : null)
      progress = priorProgress
      ordered = ordered.filter((candidate) => candidate.account.id !== accountId)
      refusals.recordPreparation()
      logPreparationThrew(ctx.log, accountId, decision.attempt, error)
      continue
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
  return finishChain(held, lastFailure, refusals.failIfAny, runtime.selectTerminal)
}
