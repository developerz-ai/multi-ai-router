import type { AttemptOutcome } from "./attempt"
import type { AttemptClock } from "./chain-relay"
import type { ServableCandidate } from "./plan"
import { attemptRecord } from "./records"
import type { DispatchRuntime } from "./runtime"

/** Provider 4xx responses are client errors too, but their known verdict is not cancellation. */
export function isCancelledOutcome(outcome: AttemptOutcome): boolean {
  return (
    outcome.kind === "failure" &&
    outcome.failure.kind === "client-error" &&
    outcome.failure.status === 499 &&
    outcome.upstream === null
  )
}

export function assertUnstartedCancellation(
  outcome: AttemptOutcome,
  started: boolean,
  signal: AbortSignal,
): void {
  if (!started && isCancelledOutcome(outcome)) signal.throwIfAborted()
}

/** A caller cancellation before relay still retains any upstream status already received. */
export function cancelledBeforeRelay(
  runtime: DispatchRuntime,
  servable: ServableCandidate,
  attempt: number,
  outcome: Exclude<AttemptOutcome, { readonly kind: "admission-refused" }>,
  at: AttemptClock,
): Response {
  try {
    if (outcome.kind === "success") void outcome.response.body?.cancel().catch(() => {})
    ;(runtime.recordTerminal ?? runtime.record)(
      attemptRecord({
        ...runtime.attribution(attempt, servable),
        priced: runtime.operation !== "count-tokens",
        timing: runtime.timing(at.startedAt, at.started, at.upstreamMs),
        outcome: "client_error",
        streamed: false,
        httpStatus:
          outcome.kind === "success" ? outcome.response.status : (outcome.upstream?.status ?? null),
        responseStatus: 499,
        errorClass: "client_cancelled",
      }),
    )
    return new Response(null, { status: 499 })
  } finally {
    runtime.activeRequest?.release()
  }
}
