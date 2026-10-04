import { toErrorResponse } from "../../errors/render"
import type { UsageRecord, UsageRequestTerminal } from "../usage"
import type { UsageRequestIdentity } from "../usage/request-identity"
import { RequestAdmissionUnavailableError, RouterShutdownError } from "./active-requests"
import type { DispatchInput } from "./dispatcher-config"
import type { RequestProgress } from "./observe"
import { outcomeForResponse } from "./observe"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { ClientCancelledError } from "./relay-cancellation"
import type { DataPlaneClock } from "./types"

/** One pending event permits final response attribution without mutating queued facts. */
export function createRequestAccounting(
  input: DispatchInput & { readonly identity: UsageRequestIdentity },
  progress: RequestProgress,
  clock: DataPlaneClock,
  write: (record: UsageRecord) => void,
  onTerminal?: (record: UsageRecord) => void,
  persistTerminal?: (terminal: UsageRequestTerminal) => void,
) {
  const identity = input.identity
  const ingress = input.ingress
  const apiKeyId = input.key.id
  let pending: UsageRecord | undefined
  let recorded = false
  let responseStatus: number | undefined
  let latest: UsageRecord | undefined
  let winner: UsageRecord | undefined
  let winnerSelected = false
  let finalized = false
  const finalize = (event: UsageRecord | undefined) => {
    if (finalized || event === undefined) return
    finalized = true
    onTerminal?.(event)
    persistTerminal?.({
      correlationId: identity.correlationId,
      winnerEventId: event.accountId === null ? null : event.eventId,
      apiKeyId,
      accountId: event.accountId,
      poolId: event.poolId,
      provider: event.provider,
      model: event.model,
      upstreamModel: event.upstreamModel,
      outcome: event.outcome,
      errorClass: event.errorClass,
      responseStatus: event.responseStatus,
      httpStatus: event.httpStatus,
      startedAt: progress.startedAt,
      settledAt: clock.now(),
      attributionKind:
        event.accountId === null
          ? "unstarted"
          : event.errorClass === "router_shutdown" || event.errorClass === "client_cancelled"
            ? "abandoned"
            : "winning-attempt",
    })
  }
  const flush = (status: number | null) => {
    if (pending === undefined) return
    write({
      ...pending,
      responseStatus:
        winnerSelected && pending.accountId !== null && pending.eventId !== winner?.eventId
          ? null
          : status,
    })
    pending = undefined
  }
  const terminalEvent = () =>
    winnerSelected
      ? (winner ??
        (latest === undefined
          ? undefined
          : {
              ...latest,
              accountId: null,
              poolId: null,
              provider: null,
              upstreamModel: null,
              httpStatus: null,
            }))
      : latest
  const record = (event: UsageRecord) => {
    latest = event
    recorded = true
    flush(null)
    if (responseStatus !== undefined) write({ ...event, responseStatus })
    else pending = event
  }
  return {
    record,
    selectTerminal(event: UsageRecord | undefined) {
      winner = event
      winnerSelected = true
    },
    recordTerminal(event: UsageRecord) {
      record(event)
      finalize(event)
    },
    abandon() {
      flush(responseStatus ?? pending?.responseStatus ?? null)
      finalize(latest)
    },
    respond(response: Response) {
      responseStatus = response.status
      // A prior failed attempt is intermediate when a new successful relay is returned.
      // An already-set status identifies a synchronous final relay event (e.g. an empty body).
      flush(response.ok ? (pending?.responseStatus ?? null) : response.status)
      const event = terminalEvent()
      if (!response.ok && event !== undefined)
        finalize({
          ...event,
          outcome: outcomeForResponse(response),
          responseStatus: response.status,
        })
    },
    fail(error: unknown) {
      const status = toErrorResponse(error, ingress).status
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
            ...identity,
            attempt: 1,
            apiKeyId,
            accountId: null,
            poolId: null,
            provider: null,
            sessionKey: null,
            model: progress.model,
            upstreamModel: null,
            ingressDialect: ingress,
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
      const event = terminalEvent()
      if (event !== undefined)
        finalize({
          ...event,
          outcome: error instanceof ClientCancelledError ? "client_error" : outcomeOf(error),
          errorClass:
            error instanceof RouterShutdownError
              ? "router_shutdown"
              : error instanceof ClientCancelledError
                ? "client_cancelled"
                : errorClassOf(error),
          responseStatus: status,
        })
    },
  }
}

export type RequestAccounting = ReturnType<typeof createRequestAccounting>
