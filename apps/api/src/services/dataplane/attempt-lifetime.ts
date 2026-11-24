import { RouterShutdownError } from "./active-requests"
import type { AttemptClock } from "./chain-relay"
import type { ServableCandidate } from "./plan"
import { attemptRecord } from "./records"
import type { RecoveryAttempt } from "./recovery-access"
import type { DispatchRuntime } from "./runtime"

/** Admission consumes a permit; only transport evidence attributes an upstream attempt. */
export function attemptLifetime(
  runtime: DispatchRuntime,
  servable: ServableCandidate,
  attempt: number,
  at: AttemptClock,
  dispatchedAt: number,
  recovery: RecoveryAttempt | undefined,
  releaseProbe: () => void,
) {
  // An HTTP span opens at the upstream call itself: the decrypt, the headers and the body copy ahead
  // of it are router work. An Agent-SDK span opens at dispatch, so its slot wait and CLI start count
  // as upstream (the labeled exception of non-negotiable 8) — as does fast-mode preparation.
  let opened = dispatchedAt
  let started = false
  let ended = false
  const end = () => {
    if (!started || ended) return
    ended = true
    runtime.health.endAttempt(servable.account.id)
  }
  runtime.activeRequest?.setAbandon(() => {
    try {
      recovery?.finish("uncertain")
      end()
      runtime.record(
        attemptRecord({
          ...(started ? runtime.attribution(attempt, servable) : runtime.preflightAttribution()),
          timing: runtime.timing(
            at.startedAt,
            at.started,
            at.upstreamMs + (started ? runtime.clock.elapsed() - opened : 0),
          ),
          outcome: "router_error",
          streamed: false,
          httpStatus: null,
          responseStatus: started ? null : 503,
          errorClass: "router_shutdown",
        }),
      )
    } finally {
      releaseProbe()
    }
  })
  return {
    started: () => started,
    /** When this attempt's upstream wait began. */
    opened: () => opened,
    end,
    onStarted() {
      if (started) return
      runtime.activeRequest?.signal.throwIfAborted()
      started = true
      if (servable.kind === "http") opened = runtime.clock.elapsed()
      runtime.health.beginAttempt(servable.account.id)
    },
    assertRunning(response?: Response) {
      if (runtime.activeRequest?.signal.aborted) {
        void response?.body?.cancel().catch(() => {})
        throw new RouterShutdownError()
      }
    },
  }
}
