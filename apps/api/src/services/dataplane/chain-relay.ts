import type { Logger } from "../../logging/logger"
import type { AttemptFailure } from "../routing"
import type { TranslationContext } from "../translate"
import { createResponseObserver } from "../usage"
import { RouterShutdownError } from "./active-requests"
import type { UpstreamError } from "./attempt"
import { breakerOptionsFor } from "./health"
import type { HealthObservation } from "./health-observation"
import type { ServableCandidate } from "./plan"
import { attemptRecord, failureOutcome } from "./records"
import type { RecoveryAttempt } from "./recovery-access"
import { relayResponse } from "./relay"
import { ClientCancelledError } from "./relay-cancellation"
import { createRelayTerminal } from "./relay-terminal"
import { relayTranslatedResponse } from "./relay-translate"
import type { DispatchRuntime } from "./runtime"

export interface AttemptClock {
  readonly startedAt: Date
  readonly started: number
  readonly upstreamMs: number
}

/**
 * An `AttemptClock` plus the moment this attempt's upstream span opened — the reading the chain
 * takes once the request body exists and before either transport is called.
 *
 * It is a separate reading from `started` because the two answer different questions. `started`
 * bounds the *attempt*, so `latencyMs` includes the conversion the router ran for it;
 * `upstreamStarted` bounds the *wait*, so `routerOverheadMs` does not. A failure closes its span in
 * the chain; a success cannot, because the stream settles long after the chain returned — so it
 * carries the open end here and `settle` closes it at the last relayed byte.
 */
export interface SuccessClock extends AttemptClock {
  readonly releaseProbe?: () => void
  readonly rateLimited?: boolean
  readonly isRateLimited?: () => boolean
  readonly onSettled?: () => void
  readonly recovery?: RecoveryAttempt
  readonly upstreamStarted: number
  readonly observation?: HealthObservation
}

/**
 * The slice of the chain's context an attempt's accounting reads. `ChainContext` satisfies it
 * structurally, so the chain passes itself and nothing has to be threaded or rebuilt.
 */
export interface AttemptRelay {
  readonly runtime: DispatchRuntime
  readonly translation: TranslationContext
  readonly log: Logger | undefined
  readonly request?: Request
}

export function relaySuccess(
  ctx: AttemptRelay,
  servable: ServableCandidate,
  attempt: number,
  response: Response,
  at: SuccessClock,
): Response {
  const observation = createResponseObserver({
    dialect: servable.dialect,
    operation: ctx.runtime.operation,
    contentType: response.headers.get("content-type"),
    maximumObservationBytes: ctx.runtime.responseObservationMaxBytes ?? 65_536,
    ...(servable.driver.responseObservation === undefined
      ? {}
      : { descriptor: servable.driver.responseObservation }),
  })
  const terminal = createRelayTerminal()
  let firstByteAt: number | undefined
  let relayedBytes = 0
  let settled = false
  const requestAborted = () =>
    settle(
      relayedBytes > 0,
      ctx.request?.signal.reason instanceof RouterShutdownError
        ? ctx.request.signal.reason
        : new ClientCancelledError(),
    )
  const settle = (streamed: boolean, error?: unknown, eof = false): void => {
    if (settled) return
    settled = true
    at.onSettled?.()
    if (error !== undefined) terminal.error(error)
    const facts = eof ? observation.finish() : observation.snapshot()
    const verdict = terminal.finish(facts)
    ctx.request?.signal.removeEventListener("abort", requestAborted)
    const counts = facts.counts
    ctx.runtime.health.endAttempt(servable.account.id, counts.tokensOut)
    try {
      const rateLimited = at.isRateLimited?.() ?? at.rateLimited ?? false
      at.recovery?.finish(rateLimited ? "failed" : verdict.recovery)
      if (verdict.failure !== null) {
        ctx.runtime.health.recordFailure(
          servable.account.id,
          { ...verdict.failure, message: "upstream response stream failed" },
          ctx.runtime.clock.now(),
          {
            ...breakerOptionsFor(servable.driver.authKind),
            recoveryProbe: at.recovery?.designated ?? false,
          },
          at.observation,
        )
      } else if (verdict.outcome === "success" && !rateLimited) {
        ctx.runtime.health.recordSuccess(servable.account.id, at.observation)
      }
      const upstreamMs = at.upstreamMs + (ctx.runtime.clock.elapsed() - at.upstreamStarted)
      ;(ctx.runtime.recordTerminal ?? ctx.runtime.record)(
        attemptRecord({
          ...ctx.runtime.attribution(attempt, servable),
          tokens: counts,
          priced: ctx.runtime.operation !== "count-tokens",
          timing: ctx.runtime.timing(at.startedAt, at.started, upstreamMs, firstByteAt),
          outcome: verdict.outcome,
          streamed,
          httpStatus: response.status,
          responseStatus: response.status,
          errorClass: verdict.errorClass,
        }),
      )
    } finally {
      try {
        at.releaseProbe?.()
      } finally {
        ctx.runtime.activeRequest?.release()
      }
    }
  }
  ctx.request?.signal.addEventListener("abort", requestAborted, { once: true })
  if (ctx.request?.signal.aborted) requestAborted()
  const lease = ctx.runtime.activeRequest
  lease?.setAbandon(() => settle(relayedBytes > 0, new RouterShutdownError()))
  if (lease?.signal.aborted) settle(false, new RouterShutdownError())
  const signals = [ctx.request?.signal, lease?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  const relaySignal = signals.length === 0 ? undefined : AbortSignal.any(signals)
  const observer = {
    onWireBytes: (bytes: number) => {
      relayedBytes = bytes
    },
    onFirstByte: () => {
      firstByteAt = ctx.runtime.clock.elapsed()
    },
    onChunk: (chunk: Uint8Array) => {
      observation.observe(chunk)
      terminal.observe(observation.snapshot())
    },
    onEnd: (bytes: number) => settle(bytes > 0, undefined, true),
    onError: (error: unknown, bytes: number) => settle(bytes > 0, error),
  }
  if (servable.translation === null) return relayResponse(response, observer, relaySignal)
  return relayTranslatedResponse({
    upstream: response,
    pair: servable.translation,
    context: ctx.translation,
    observer,
    ...(relaySignal === undefined ? {} : { signal: relaySignal }),
    onUnrecognizedStopReason: (reason) =>
      ctx.log?.warn("upstream reported an unrecognized stop reason", {
        accountId: servable.account.id,
        provider: servable.account.driver.provider,
        stopReason: reason,
      }),
  })
}

export function recordAttemptFailure(
  ctx: AttemptRelay,
  servable: ServableCandidate,
  attempt: number,
  failure: AttemptFailure,
  upstream: UpstreamError | null,
  at: AttemptClock,
): void {
  ctx.runtime.record(
    attemptRecord({
      ...ctx.runtime.attribution(attempt, servable),
      // Same rule on the way down: a count that never landed is no more priceable than one that did.
      priced: ctx.runtime.operation !== "count-tokens",
      timing: ctx.runtime.timing(at.startedAt, at.started, at.upstreamMs),
      outcome: failureOutcome(failure.kind),
      streamed: false,
      httpStatus: upstream?.status ?? null,
      errorClass: null,
    }),
  )
}
