import type { UsageRecord } from "../usage"
import {
  type ActiveRequestRegistry,
  RequestAdmissionUnavailableError,
  RouterShutdownError,
} from "./active-requests"
import type { DispatchInput } from "./dispatcher-config"
import { outcomeOf } from "./records"
import { ClientCancelledError } from "./relay-cancellation"
import type { createRequestAccounting } from "./request-accounting"

/** Freeze abandoned producers before the composition root drains usage writers. */
export function requestLifetime(
  input: DispatchInput,
  registry: ActiveRequestRegistry | undefined,
  accounting: ReturnType<typeof createRequestAccounting>,
) {
  let abandoned = false
  const lease = registry?.register()
  const unavailable = registry !== undefined && lease === undefined
  const record = (event: UsageRecord) => {
    if (!abandoned) accounting.record(event)
  }
  const activeRequest =
    lease === undefined
      ? undefined
      : {
          signal: lease.signal,
          release: () => lease.release(),
          setAbandon(callback: () => void) {
            lease.setAbandon(() => {
              try {
                callback()
              } finally {
                try {
                  accounting.abandon()
                } finally {
                  abandoned = true
                }
              }
            })
          },
        }
  activeRequest?.setAbandon(() => accounting.fail(new RouterShutdownError()))
  const request =
    lease === undefined
      ? input.request
      : new Request(input.request, {
          signal: AbortSignal.any([input.request.signal, lease.signal]),
        })
  return {
    input: { ...input, request, ...(activeRequest === undefined ? {} : { activeRequest }) },
    record,
    selectTerminal(event: UsageRecord | undefined) {
      if (!abandoned) accounting.selectTerminal(event)
    },
    recordTerminal(event: UsageRecord) {
      if (!abandoned) accounting.recordTerminal(event)
    },
    assertAvailable() {
      if (unavailable) throw new RequestAdmissionUnavailableError()
      if (abandoned) throw new RouterShutdownError()
    },
    fail(error: unknown) {
      const failure =
        input.request.signal.aborted && error === input.request.signal.reason
          ? new ClientCancelledError()
          : error
      try {
        if (!abandoned) accounting.fail(failure)
      } finally {
        lease?.release()
      }
      return {
        error: failure,
        outcome:
          failure instanceof ClientCancelledError ? ("client_error" as const) : outcomeOf(failure),
      }
    },
  }
}
