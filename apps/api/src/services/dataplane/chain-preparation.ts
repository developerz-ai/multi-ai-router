import { InvalidRequestError } from "@multi-ai-router/core"
import type { AttemptOutcome } from "./attempt"
import type { AttemptClock } from "./chain-relay"
import { attemptRecord } from "./records"
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
