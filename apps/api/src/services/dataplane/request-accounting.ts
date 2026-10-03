import { toErrorResponse } from "../../errors/render"
import type { UsageRecord } from "../usage"
import type { UsageRequestIdentity } from "../usage/request-identity"
import { RequestAdmissionUnavailableError, RouterShutdownError } from "./active-requests"
import type { DispatchInput } from "./dispatcher-config"
import type { RequestProgress } from "./observe"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { ClientCancelledError } from "./relay-cancellation"
import type { DataPlaneClock } from "./types"

/** One pending event permits final response attribution without mutating queued facts. */
export function createRequestAccounting(
  input: DispatchInput & { readonly identity: UsageRequestIdentity },
  progress: RequestProgress,
  clock: DataPlaneClock,
  write: (record: UsageRecord) => void,
) {
  let pending: UsageRecord | undefined
  let recorded = false
  let responseStatus: number | undefined
  const flush = (status: number | null) => {
    if (pending === undefined) return
    write({ ...pending, responseStatus: status })
    pending = undefined
  }
  const record = (event: UsageRecord) => {
    recorded = true
    flush(null)
    if (responseStatus !== undefined) write({ ...event, responseStatus })
    else pending = event
  }
  return {
    record,
    abandon() {
      flush(responseStatus ?? pending?.responseStatus ?? null)
    },
    respond(response: Response) {
      responseStatus = response.status
      // A prior failed attempt is intermediate when a new successful relay is returned.
      // An already-set status identifies a synchronous final relay event (e.g. an empty body).
      flush(response.ok ? (pending?.responseStatus ?? null) : response.status)
    },
    fail(error: unknown) {
      const status = toErrorResponse(error, input.ingress).status
      if (!recorded) {
        const finished = clock.elapsed()
        const elapsed = Math.max(0, finished - progress.requestStarted)
        const bodyReadMs =
          progress.bodyReadMs +
          (progress.bodyReadWaitingSince === undefined
            ? 0
            : Math.max(0, finished - progress.bodyReadWaitingSince))
        record(
          attemptRecord({
            ...input.identity,
            attempt: 1,
            apiKeyId: input.key.id,
            accountId: null,
            poolId: null,
            provider: null,
            sessionKey: null,
            model: progress.model,
            upstreamModel: null,
            ingressDialect: input.ingress,
            egressMode: null,
            priced: false,
            timing: {
              startedAt: progress.startedAt,
              finishedAt: clock.now(),
              latencyMs: elapsed,
              totalMs: elapsed,
              upstreamMs: 0,
              bodyReadMs,
            },
            outcome: error instanceof ClientCancelledError ? "client_error" : outcomeOf(error),
            streamed: false,
            httpStatus: null,
            responseStatus: status,
            errorClass:
              error instanceof RouterShutdownError
                ? "router_shutdown"
                : error instanceof RequestAdmissionUnavailableError
                  ? "request_admission_unavailable"
                  : error instanceof ClientCancelledError
                    ? "client_cancelled"
                    : errorClassOf(error),
          }),
        )
      }
      responseStatus = status
      flush(status)
    },
  }
}
