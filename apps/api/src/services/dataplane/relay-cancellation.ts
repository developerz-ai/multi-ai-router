import { isRouterError } from "@multi-ai-router/core"
import { RouterShutdownError } from "./active-requests"

/** A downstream cancellation is not evidence that an upstream account failed. */
export class ClientCancelledError extends Error {
  constructor() {
    super("client cancelled the response")
    this.name = "ClientCancelledError"
  }
}

/**
 * The error a cancelled relay must report, from the abort's **reason** alone.
 *
 * The relay's signal can be aborted by the router's own clocks or shutdown as well as by the
 * client, so an abort while bytes are in flight is not, on its own, evidence of a client
 * disconnect. Only a genuine client abort stays a cancellation; a router abort reports the error
 * that caused it, so the usage row records what actually happened.
 *
 * This is the one place the client/router boundary is drawn. Every settle that observes an abort —
 * a signal, or a bare `reason` a listener already holds — classifies through here; a second copy of
 * the test below is the regression this module exists to prevent.
 */
export function cancellationError(reason: unknown): Error {
  return isRouterAbort(reason) ? reason : new ClientCancelledError()
}

/** The error a cancelled relay reports, reading the reason off an `AbortSignal` (aborted or not). */
export function relayCancellationError(signal: AbortSignal | undefined): Error {
  return cancellationError(signal?.aborted === true ? signal.reason : undefined)
}

/**
 * A router abort is a **named** router cause, and nothing else.
 *
 * The client/router boundary is a closed allowlist, never a blocklist. The platform's own
 * `AbortError` means the caller left, and any reason the router did not name is still the
 * caller's act, not the account's: a default that read every `Error` as a router abort fails the
 * opposite way, filing the runtime's own loopback or the listener's idle reap (`request-lifetime`,
 * `caller-cancellation.test.ts`, `header-cancellation.test.ts`) as an `upstream_error` row and
 * striking a breaker for an account that never answered.
 *
 * `instanceof` on one router class is not a classification: this names every router cause that can
 * reach a relay signal today, and a new one lands here beside the class that raises it.
 */
function isRouterAbort(reason: unknown): reason is Error {
  return (
    isRouterError(reason) ||
    reason instanceof RouterShutdownError ||
    (reason instanceof Error && reason.name === "TimeoutError")
  )
}

/** Observe the readable side explicitly: cancelling it need not abort the original Request. */
export function observeCancellation(
  stream: ReadableStream<Uint8Array>,
  cancelled: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      async cancel(reason) {
        cancelled()
        await reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
