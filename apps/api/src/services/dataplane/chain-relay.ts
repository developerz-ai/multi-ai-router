import { createResponseObserver } from "../usage"
import { RouterShutdownError } from "./active-requests"
import { logStreamFailure } from "./attempt-log"
import { reasoningSealFor } from "./chain-body"
import type { AttemptRelay, SuccessClock } from "./chain-relay-types"
import { DEFAULT_LOG_REASON_MAX_CHARS } from "./dispatcher-config"
import { coerceForcedToolResponse } from "./forced-tool-coercion"
import { breakerOptionsFor } from "./health"
import { observingModelOutput } from "./model-output"
import { forcesUpstreamStream, type ServableCandidate } from "./plan"
import { withReasoningSeal } from "./reasoning-seal-context"
import { attemptCost, attemptRecord } from "./records"
import { relayResponse } from "./relay"
import { ClientCancelledError } from "./relay-cancellation"
import { type CostReport, usageCostFields } from "./relay-cost"
import { costRequested, restampingPair } from "./relay-cost-optin"
import { endsWithRouterError } from "./relay-stream-end"
import { createRelayTerminal } from "./relay-terminal"
import { relayTranslatedResponse } from "./relay-translate"
import { refusedStatus } from "./relay-translate-held"
import { streamCapSignal } from "./stream-cap"

export type { AttemptClock, AttemptRelay, SuccessClock } from "./chain-relay-types"

export function relaySuccess(
  ctx: AttemptRelay,
  servable: ServableCandidate,
  attempt: number,
  received: Response,
  at: SuccessClock,
): Response {
  const response =
    at.forcedTool === undefined
      ? received
      : coerceForcedToolResponse(
          received,
          at.forcedTool,
          (streamed) =>
            // Counted by line, never by content: how often a vendor ignores a forced tool.
            ctx.log?.info("forced tool answered in text; coerced to tool_use", {
              event: "forced_tool_coerced",
              accountId: servable.account.id,
              provider: servable.account.driver.provider,
              streamed,
            }),
          ctx.request?.signal,
          undefined,
          ctx.runtime.bufferedBodyMaxBytes,
        )
  const upstreamStreams = forcesUpstreamStream(servable)
  // Whether the body is SSE whatever its `content-type` says: the driver declares a surface that
  // answers only as a stream (Codex sends one with no `content-type` at all), translated or not.
  const sendsSse = servable.responsesEgress.requireStream
  let modelOutput = false
  // Usage is read off the upstream's frames; a forced stream is SSE whether or not it said so.
  const observedType = sendsSse ? "text/event-stream" : response.headers.get("content-type")
  const framesMidBody = observedType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
  const descriptor = observingModelOutput(
    servable.dialect,
    servable.driver.responseObservation,
    () => {
      modelOutput = true
    },
  )
  const observation = createResponseObserver({
    dialect: servable.dialect,
    operation: ctx.runtime.operation,
    contentType: observedType,
    maximumObservationBytes: ctx.runtime.responseObservationMaxBytes ?? 65_536,
    descriptor,
  })
  const terminal = createRelayTerminal()
  const capSignal = (error: unknown) =>
    streamCapSignal(servable.driver.responseObservation, error, observation.terminal, {
      streamMs: ctx.runtime.clock.elapsed() - at.upstreamStarted,
      minMs: ctx.runtime.streamCapMinMs,
    })
  const clientStreams = ctx.translated?.clientStreams() === true
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
    if (error !== undefined) terminal.error(error, modelOutput, capSignal(error))
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
      } else if (verdict.recovery === "succeeded" && !rateLimited) {
        // A clean finish, or a client cancel after the model already produced output.
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
          // A held translation the router could not convert was answered as its typed `502`.
          responseStatus:
            refusedStatus(error, streamed, servable.translation !== null && !clientStreams) ??
            response.status,
          errorClass: verdict.errorClass,
        }),
      )
      // Last, so a logging fault cannot cost the breaker update or the usage row above.
      if (verdict.failure !== null) {
        logStreamFailure(
          ctx.log,
          servable.account.id,
          verdict.errorClass,
          facts.provider?.message,
          ctx.reasonMaxChars ?? DEFAULT_LOG_REASON_MAX_CHARS,
          error,
          descriptor.eventTypes?.(),
        )
      }
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
      // Only an SSE body completes a frame mid-body; a JSON one is read at `finish`. The live
      // getters say whether a verdict landed, so the snapshot is taken only then (02.2).
      if (
        framesMidBody &&
        (observation.failure !== null ||
          observation.terminal === "explicit_error" ||
          observation.terminal === "explicit_incomplete")
      )
        terminal.observe(observation.snapshot())
    },
    onEnd: (bytes: number) => settle(bytes > 0, undefined, true),
    onError: (error: unknown, bytes: number) => settle(bytes > 0, error),
  }
  // Only inference has a completion to price.
  const priced = ctx.runtime.operation === "messages"
  const restamp =
    servable.translation === null &&
    priced &&
    ctx.request !== undefined &&
    costRequested(ctx.request.headers)
  // A client stream that breaks after its first byte ends with the router's error event.
  const ended = (relayed: Response): Response =>
    relayed.headers.get("content-type")?.includes("text/event-stream") === true ||
    (sendsSse && servable.translation === null)
      ? endsWithRouterError(
          relayed,
          ctx.runtime.ingressDialect,
          {
            requestId: ctx.runtime.requestId ?? null,
            attempt,
            accountId: servable.account.id,
          },
          ctx.request?.signal,
        )
      : relayed
  if (servable.translation === null && !restamp)
    return ended(relayResponse(response, observer, relaySignal))
  const cost: CostReport = {
    ingress: ctx.runtime.ingressDialect,
    fields: (whole) => {
      // A JSON body's usage reads only at its end, and `whole` says the end has been observed.
      const facts = whole ? observation.finish() : observation.snapshot()
      const attribution = ctx.runtime.attribution(attempt, servable)
      return usageCostFields(facts, attemptCost({ ...attribution, tokens: facts.counts }))
    },
  }
  return ended(
    relayTranslatedResponse({
      upstream: response,
      refusal: {
        ingress: ctx.runtime.ingressDialect,
        requestId: ctx.runtime.requestId ?? null,
        accountId: servable.account.id,
        attempt,
      },
      pair: servable.translation ?? restampingPair(servable.dialect),
      // The same account's seal the request was converted under, so reasoning this upstream issues
      // is sealed to it and only it.
      context: withReasoningSeal(
        { ...ctx.translation, includeUsage: ctx.translated?.includeUsage() === true },
        reasoningSealFor(ctx, servable),
      ),
      // Only for a client that did not ask to stream; one that did is forwarded event by event. A
      // restamped passthrough keeps the upstream's framing, so it is never collected.
      collectStream:
        servable.translation !== null &&
        upstreamStreams &&
        ctx.translated?.clientStreams() !== true,
      upstreamStreams: sendsSse,
      ...(ctx.runtime.bufferedBodyMaxBytes === undefined
        ? {}
        : { bufferedBodyMaxBytes: ctx.runtime.bufferedBodyMaxBytes }),
      ...(ctx.runtime.translationFrameMaxBytes === undefined
        ? {}
        : { maximumFrameLength: ctx.runtime.translationFrameMaxBytes }),
      ...(priced ? { cost } : {}),
      observer,
      ...(relaySignal === undefined ? {} : { signal: relaySignal }),
      onUnrecognizedStopReason: (reason) =>
        ctx.log?.warn("upstream reported an unrecognized stop reason", {
          accountId: servable.account.id,
          provider: servable.account.driver.provider,
          stopReason: reason,
        }),
    }),
  )
}
