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
    /**
     * Read the inbound signal only, and only for equality.
     *
     * This tests `input.request`, never the composed signal at `:45-50`: the lease signal is added
     * to a **new** `Request`, so a `RouterShutdownError` cannot arrive here, and a shutdown is
     * settled by the abandon callback above instead. What lands here is whatever the runtime
     * aborted the inbound request with, which is the client's own column (a downstream disconnect,
     * or the listener reaping a vanished socket on its idle clock); that is why an unrecognised
     * reason is flattened rather than passed through, and `caller-cancellation.test.ts` pins a
     * plain `Error` from the caller as `client_cancelled` / `499`. Every settle that can see a
     * **router** reason classifies it through `relay-cancellation.ts` instead; if a router cause is
     * ever wired onto the inbound signal, this line must go through `cancellationError` too, never
     * a constant.
     */
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
