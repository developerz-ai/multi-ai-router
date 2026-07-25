import {
  type Dialect,
  isRouterError,
  NoHealthyAccountError,
  type RouterError,
} from "@multi-ai-router/core"
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
import type { TranslationContext } from "../translate"
import { createTokenObserver } from "../usage"
import { type AttemptOutcome, runAttempt, type UpstreamError } from "./attempt"
import { rewriteModel } from "./body/read"
import type { ByteSpan } from "./body/scanner"
import { breakerOptionsFor } from "./health"
import type { ServableCandidate } from "./plan"
import { attemptRecord, failureOutcome, SUCCESS_OUTCOME } from "./records"
import { relayResponse } from "./relay"
import { relayUpstreamError } from "./relay-error"
import { relayTranslatedResponse } from "./relay-translate"
import type { DispatchRuntime } from "./runtime"
import { runSdkAttempt } from "./sdk-attempt"
import type { TranslatedRequestBody } from "./translate-body"

/**
 * The failover chain: dispatch to the head, advance on a retryable failure, stop honestly.
 *
 * **Once any byte has been written to the client, failover is over.** That is enforced by
 * structure, not by a flag someone has to remember to check: the success branch returns the relayed
 * response and never re-enters the loop. `markStreamed` records the same fact for the failover
 * planner, which refuses every retry from that point on.
 *
 * Attempts are bounded, each one a distinct account — except the single in-place replay a stale SDK
 * session earns — and every one writes its own `UsageRecord`, sharing the request's correlation id.
 */

export interface ChainContext {
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
  readonly log: Logger | undefined
}

export async function runChain(ctx: ChainContext): Promise<Response> {
  const ordered: readonly Candidate[] = ctx.plan.map((entry) => entry.candidate)
  const byId = new Map(ctx.plan.map((entry) => [entry.candidate.account.id, entry]))
  const { runtime } = ctx

  let progress = NO_ATTEMPTS
  let lastFailure: AttemptFailure | null = null
  let lastUpstream: UpstreamError | null = null
  /** The dialect the last upstream error must be re-rendered into, or null when it already is. */
  let lastUpstreamDialect: Dialect | null = null
  let lastError: RouterError | null = null
  let upstreamMs = 0

  for (;;) {
    const decision = planNextAttempt(ordered, progress, lastFailure, ctx.failover)
    if (decision.action === "stop") break

    const servable = byId.get(decision.candidate.account.id)
    if (servable === undefined) break

    const accountId = servable.account.id
    progress = recordAttempt(progress, accountId, decision.action === "retry-in-place")
    runtime.health.beginAttempt(accountId)

    const attemptStartedAt = runtime.clock.now()
    const attemptStarted = runtime.clock.elapsed()
    const at = { startedAt: attemptStartedAt, started: attemptStarted, upstreamMs }

    // Before the call, never during it: a body with no faithful representation in this account's
    // dialect is a `400` naming the field, and the spec requires it to land before any upstream is
    // touched. `client-error` is not retryable, which is the right answer — a bad request is bad at
    // every account that would need the same conversion.
    let upstreamBody: Uint8Array | null
    try {
      upstreamBody = bodyFor(ctx, servable)
    } catch (error) {
      runtime.health.endAttempt(accountId)
      if (!isRouterError(error)) throw error
      lastError = error
      lastFailure = { kind: "client-error", message: error.message }
      recordFailure(ctx, servable, decision.attempt, lastFailure, null, { ...at, upstreamMs })
      continue
    }

    let outcome: AttemptOutcome
    try {
      outcome = await dispatch(ctx, servable, upstreamBody)
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

    // Applied after the verdict, never before: `recordSuccess`'s unconditional reset to `active`
    // would otherwise erase a `rejected` reading's cooldown on an otherwise-200 response.
    if (outcome.kind === "success") {
      runtime.health.recordSuccess(accountId)
      runtime.health.applyRateLimit(accountId, outcome.rateLimit, attemptStartedAt)
      progress = markStreamed(progress)
      return relaySuccess(ctx, servable, decision.attempt, outcome.response, at)
    }

    runtime.health.recordFailure(
      accountId,
      outcome.failure,
      attemptStartedAt,
      breakerOptionsFor(servable.driver.authKind),
    )
    runtime.health.applyRateLimit(accountId, outcome.rateLimit, attemptStartedAt)
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
    // A translated attempt's error body is the *account's* dialect. The client is owed its own.
    lastUpstreamDialect = servable.translation === null ? null : runtime.ingressDialect
    lastError = outcome.classification === null ? null : toRouterError(outcome.classification)
  }

  // The failure that surfaces is the **last** attempt's. A router-shaped one — 429 with a reset,
  // 402 saying a human must top up, 502 saying the *account's* credential failed rather than the
  // caller's — is thrown so it renders in the ingress dialect. Anything else is the upstream's own
  // answer, relayed unchanged: a bad request is bad at every account, and the provider's reply is
  // the honest one.
  if (lastError !== null) throw lastError
  if (lastUpstream !== null) return relayUpstreamError(lastUpstream, lastUpstreamDialect)
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
 * The one place the two transports diverge. Both answer with the same `AttemptOutcome`, so the loop
 * above, the health store, the records, and the relay below are written once — from here down,
 * nothing can tell a re-synthesized SDK `Response` from one relayed off a socket.
 */
function dispatch(
  ctx: ChainContext,
  servable: ServableCandidate,
  body: Uint8Array | null,
): Promise<AttemptOutcome> {
  const { runtime } = ctx
  if (servable.kind === "sdk") {
    return runSdkAttempt({
      plan: servable,
      body,
      invoke: runtime.invokeSdk,
      session: runtime.session,
      quota: runtime.quota,
      now: runtime.clock.now,
      timeoutMs: runtime.timeoutMs,
      signal: ctx.request.signal,
    })
  }

  return runAttempt({
    plan: servable,
    method: ctx.request.method,
    clientHeaders: ctx.request.headers,
    body,
    fetch: runtime.call,
    cipher: runtime.cipher,
    timeoutMs: runtime.timeoutMs,
    signal: ctx.request.signal,
  })
}

/**
 * The body this account gets. Passthrough: identical bytes, unless the account's alias map renames
 * the model — the one edit a passthrough body ever receives. Translate: rebuilt field by field,
 * which a Claude subscription also takes since the SDK's prompt is built from Anthropic-shaped
 * bytes either way.
 *
 * @throws TranslationError when a translated body has a field with no target representation.
 */
function bodyFor(ctx: ChainContext, servable: ServableCandidate): Uint8Array | null {
  const pair = servable.translation
  if (pair !== null) return ctx.translated.bodyFor(pair, servable.upstreamModel)
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
  let firstByteAt: number | undefined
  const settle = (streamed: boolean): void => {
    const counts = tokens.counts()
    ctx.runtime.health.endAttempt(servable.account.id, counts.tokensOut)
    ctx.runtime.record(
      attemptRecord({
        ...ctx.runtime.attribution(attempt, servable),
        tokens: counts,
        timing: ctx.runtime.timing(at.startedAt, at.started, at.upstreamMs, firstByteAt),
        outcome: SUCCESS_OUTCOME,
        streamed,
        httpStatus: response.status,
        errorClass: null,
      }),
    )
  }

  const observer = {
    onFirstByte: () => {
      firstByteAt = ctx.runtime.clock.elapsed()
    },
    onChunk: (chunk: Uint8Array) => tokens.observe(chunk),
    onEnd: (bytes: number) => settle(bytes > 0),
    // A stream that broke after bytes were on the wire is a truncation, never a retry.
    onError: () => settle(true),
  }

  const pair = servable.translation
  if (pair === null) return relayResponse(response, observer)

  return relayTranslatedResponse({
    upstream: response,
    pair,
    context: ctx.translation,
    observer,
    onUnrecognizedStopReason: (reason) =>
      ctx.log?.warn("upstream reported an unrecognized stop reason", {
        accountId: servable.account.id,
        provider: servable.account.driver.provider,
        stopReason: reason,
      }),
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
