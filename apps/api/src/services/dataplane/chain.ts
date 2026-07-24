import { isRouterError, NoHealthyAccountError, type RouterError } from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import { toRouterError } from "../../providers"
import {
  type AttemptFailure,
  type Candidate,
  type FailoverOptions,
  markStreamed,
  NO_ATTEMPTS,
  planNextAttempt,
  recordAttempt,
} from "../routing"
import { createTokenObserver } from "../usage"
import { runAttempt, type UpstreamError } from "./attempt"
import { rewriteModel } from "./body/read"
import type { ByteSpan } from "./body/scanner"
import { breakerOptionsFor } from "./health"
import type { ServableCandidate } from "./plan"
import { attemptRecord, failureOutcome, SUCCESS_OUTCOME } from "./records"
import { relayResponse } from "./relay"
import type { DispatchRuntime } from "./runtime"

/**
 * The failover chain: dispatch to the head, advance on a retryable failure, stop honestly.
 *
 * **Once any byte has been written to the client, failover is over.** That is enforced by
 * structure, not by a flag someone has to remember to check: the success branch returns the relayed
 * response and never re-enters the loop. `markStreamed` records the same fact for the failover
 * planner, which refuses every retry from that point on.
 *
 * Attempts are bounded, each one is a distinct account, and every one of them — success or
 * failure — writes its own `UsageRecord`, all sharing the request's correlation id.
 */

export interface ChainContext {
  readonly runtime: DispatchRuntime
  readonly plan: readonly ServableCandidate[]
  /** The client's request: method, headers, and abort signal are taken from it. */
  readonly request: Request
  readonly bodyBytes: Uint8Array
  readonly modelSpan: ByteSpan | null
  readonly failover: FailoverOptions | undefined
  readonly log: Logger | undefined
}

export async function runChain(ctx: ChainContext): Promise<Response> {
  const ordered: readonly Candidate[] = ctx.plan.map((entry) => entry.candidate)
  const byId = new Map(ctx.plan.map((entry) => [entry.candidate.account.id, entry]))
  const { runtime } = ctx

  let progress = NO_ATTEMPTS
  let lastFailure: AttemptFailure | null = null
  let lastUpstream: UpstreamError | null = null
  let lastError: RouterError | null = null
  let upstreamMs = 0

  for (;;) {
    const decision = planNextAttempt(ordered, progress, lastFailure, ctx.failover)
    if (decision.action !== "attempt") break

    const servable = byId.get(decision.candidate.account.id)
    if (servable === undefined) break

    const accountId = servable.account.id
    progress = recordAttempt(progress, accountId)
    runtime.health.beginAttempt(accountId)

    const attemptStartedAt = runtime.clock.now()
    const attemptStarted = runtime.clock.elapsed()
    const at = { startedAt: attemptStartedAt, started: attemptStarted, upstreamMs }

    let outcome: Awaited<ReturnType<typeof runAttempt>>
    try {
      outcome = await runAttempt({
        plan: servable,
        method: ctx.request.method,
        clientHeaders: ctx.request.headers,
        body: bodyFor(ctx, servable),
        fetch: runtime.call,
        cipher: runtime.cipher,
        timeoutMs: runtime.timeoutMs,
        signal: ctx.request.signal,
      })
    } catch (error) {
      // A credential that will not decrypt, or a driver that refused to build the request. This
      // account cannot serve; the next one still can, and the reason is kept in case none can.
      runtime.health.endAttempt(accountId)
      upstreamMs += runtime.clock.elapsed() - attemptStarted
      lastError = isRouterError(error) ? error : null
      lastFailure = { kind: "server-error", message: "the account could not be dispatched to" }
      recordFailure(ctx, servable, decision.attempt, lastFailure, null, { ...at, upstreamMs })
      continue
    }

    runtime.health.applyRateLimit(accountId, outcome.rateLimit, attemptStartedAt)

    if (outcome.kind === "success") {
      runtime.health.recordSuccess(accountId)
      progress = markStreamed(progress)
      return relaySuccess(ctx, servable, decision.attempt, outcome.response, at)
    }

    runtime.health.recordFailure(
      accountId,
      outcome.failure,
      attemptStartedAt,
      breakerOptionsFor(servable.driver.authKind),
    )
    runtime.health.endAttempt(accountId)
    upstreamMs += runtime.clock.elapsed() - attemptStarted

    recordFailure(ctx, servable, decision.attempt, outcome.failure, outcome.upstream, {
      ...at,
      upstreamMs,
    })
    ctx.log?.warn("upstream attempt failed", {
      accountId,
      attempt: decision.attempt,
      status: outcome.failure.status,
      failureKind: outcome.failure.kind,
    })

    lastFailure = outcome.failure
    lastUpstream = outcome.upstream
    lastError = outcome.classification === null ? null : toRouterError(outcome.classification)
  }

  // The failure that surfaces is the **last** attempt's. A router-shaped one — 429 with a reset,
  // 402 saying a human must top up, 502 saying the *account's* credential failed rather than the
  // caller's — is thrown so it renders in the ingress dialect. Anything else is the upstream's own
  // answer, relayed unchanged: a bad request is bad at every account, and the provider's reply is
  // the honest one.
  if (lastError !== null) throw lastError
  if (lastUpstream !== null) return relayUpstreamError(lastUpstream)
  if (lastFailure !== null) {
    throw new NoHealthyAccountError(`every attempt failed: ${lastFailure.message}`)
  }
  throw new NoHealthyAccountError("no candidate account could be attempted")
}

interface AttemptClock {
  readonly startedAt: Date
  readonly started: number
  readonly upstreamMs: number
}

/**
 * The body this account gets. Identical bytes unless its operator-authored alias map renames the
 * model — the one edit a passthrough body ever receives, and even then only the model's own bytes
 * move. No parse, no re-serialization, no dropped unknown field.
 */
function bodyFor(ctx: ChainContext, servable: ServableCandidate): Uint8Array | null {
  if (ctx.bodyBytes.length === 0) return null
  if (ctx.modelSpan === null || servable.upstreamModel === ctx.runtime.model) return ctx.bodyBytes
  return rewriteModel(ctx.bodyBytes, ctx.modelSpan, servable.upstreamModel)
}

function relaySuccess(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  response: Response,
  at: AttemptClock,
): Response {
  const tokens = createTokenObserver()
  const settle = (streamed: boolean): void => {
    const counts = tokens.counts()
    ctx.runtime.health.endAttempt(servable.account.id, counts.tokensOut)
    ctx.runtime.record(
      attemptRecord({
        ...ctx.runtime.attribution(attempt, servable),
        tokens: counts,
        timing: ctx.runtime.timing(at.startedAt, at.started, at.upstreamMs),
        outcome: SUCCESS_OUTCOME,
        streamed,
        httpStatus: response.status,
        errorClass: null,
      }),
    )
  }

  return relayResponse(response, {
    onChunk: (chunk) => tokens.observe(chunk),
    onEnd: (bytes) => settle(bytes > 0),
    // A stream that broke after bytes were on the wire is a truncation, never a retry.
    onError: () => settle(true),
  })
}

function recordFailure(
  ctx: ChainContext,
  servable: ServableCandidate,
  attempt: number,
  failure: AttemptFailure,
  upstream: UpstreamError | null,
  at: AttemptClock,
): void {
  ctx.runtime.record(
    attemptRecord({
      ...ctx.runtime.attribution(attempt, servable),
      timing: ctx.runtime.timing(at.startedAt, at.started, at.upstreamMs),
      outcome: failureOutcome(failure.kind),
      streamed: false,
      httpStatus: upstream?.status ?? null,
      errorClass: null,
    }),
  )
}

/** The upstream's own error body, unchanged — it is already in the ingress dialect's shape. */
function relayUpstreamError(upstream: UpstreamError): Response {
  const headers = new Headers()
  if (upstream.contentType !== null) headers.set("content-type", upstream.contentType)
  const retryAfter = upstream.headers.get("retry-after")
  if (retryAfter !== null) headers.set("retry-after", retryAfter)
  return new Response(upstream.bodyText, { status: upstream.status, headers })
}
