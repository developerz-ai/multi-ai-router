import { InvalidRequestError, type RouterError } from "@multi-ai-router/core"
import type { AttemptOutcome } from "./attempt"
import type { AttemptClock } from "./chain-relay"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import type { DispatchRuntime } from "./runtime"

/** SDK validation before query is a caller refusal, with no upstream account or status. */
export function invalidPreparation(
  runtime: DispatchRuntime,
  outcome: AttemptOutcome,
  at: AttemptClock,
): InvalidRequestError | undefined {
  if (outcome.kind !== "failure" || outcome.failure.kind !== "client-error") return
  const error = new InvalidRequestError(outcome.failure.message)
  runtime.record(
    attemptRecord({
      ...runtime.preflightAttribution(),
      timing: runtime.timing(at.startedAt, at.started, at.upstreamMs),
      outcome: "client_error",
      streamed: false,
      httpStatus: null,
      errorClass: error.name,
    }),
  )
  return error
}

/** A body this candidate's dialect cannot represent: refused before any upstream span opened. */
export function recordUnrepresentable(
  runtime: DispatchRuntime,
  error: RouterError,
  at: AttemptClock,
): void {
  runtime.record(
    attemptRecord({
      ...runtime.preflightAttribution(),
      timing: runtime.timing(at.startedAt, at.started, at.upstreamMs),
      outcome: "client_error",
      streamed: false,
      httpStatus: null,
      errorClass: error.name,
    }),
  )
}

/** The single row a request refused before any attempt owes, then the refusal itself. */
export function preflightRefusal(
  runtime: DispatchRuntime,
  startedAt: Date,
  requestStarted: number,
) {
  return (error: RouterError): never => {
    runtime.record(
      attemptRecord({
        ...runtime.preflightAttribution(),
        timing: runtime.timing(startedAt, requestStarted, 0),
        outcome: outcomeOf(error),
        streamed: false,
        httpStatus: null,
        errorClass: errorClassOf(error),
      }),
    )
    throw error
  }
}
