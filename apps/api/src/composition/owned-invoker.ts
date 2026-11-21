import type { SdkInvoker } from "../providers/claude-sdk/invoke"
import type { ReplicaLeaseManager } from "../providers/claude-sdk/replica-lease"
import { UpstreamAdmissionRefused } from "../providers/upstream-admission"

/**
 * Authority follows the body through completion or cancellation.
 *
 * The transport only asks the lease once, when it starts; a replica that loses its generation
 * mid-turn would otherwise keep relaying bytes under an ownership fence it no longer holds. So the
 * composed invocation re-asserts the handle before the upstream starts, after it answers, and on
 * every body pull, and aborts the upstream signal the moment the lease closes admission.
 */
export function ownedInvoker(
  leases: Pick<ReplicaLeaseManager, "handle">,
  invoke: SdkInvoker,
): SdkInvoker {
  return async (input) => {
    const handle = leases.handle(input.accountId)
    handle.assert()
    const signal = AbortSignal.any([input.signal, handle.signal])
    const beforeUpstreamStart = Object.assign(
      () => {
        handle.assert()
        input.beforeUpstreamStart?.()
      },
      input.beforeUpstreamStart?.singleStart === undefined
        ? {}
        : { singleStart: input.beforeUpstreamStart.singleStart },
    )
    const response = await invoke({ ...input, signal, beforeUpstreamStart })
    try {
      handle.assert()
    } catch (error) {
      await response.body?.cancel(error)
      throw error
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    let abort = () => {}
    const clean = () => signal.removeEventListener("abort", abort)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => {
          clean()
          controller.error(new UpstreamAdmissionRefused("account replica ownership lost"))
          void reader.cancel().catch(() => {})
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      },
      async pull(controller) {
        try {
          handle.assert()
          const part = await reader.read()
          handle.assert()
          if (part.done) {
            clean()
            controller.close()
          } else controller.enqueue(part.value)
        } catch (error) {
          clean()
          controller.error(error)
          await reader.cancel(error).catch(() => {})
        }
      },
      async cancel(reason) {
        clean()
        await reader.cancel(reason)
      },
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
