import { clientHeaders } from "./egress/headers"

/**
 * Stream relay. **This is the hard requirement, not a preference.**
 *
 * Upstream bytes reach the client as they arrive: no accumulate-then-forward, no re-chunking, and
 * no waiting for a complete SSE event before flushing (docs/idea/06-protocol-translation.md,
 * performance rules). The chunk the upstream produced is the chunk the client receives, in the
 * same shape, at the earliest moment it can be handed over.
 *
 * Observation rides along without delaying anything: every chunk is **enqueued first** and only
 * then shown to the observer, so token counting can never sit between a byte and the client. If
 * an observer throws, the relay keeps going — reporting must never break traffic.
 *
 * Once this returns, failover is over. Bytes are committed to the wire, and replaying a partially
 * delivered stream would produce a response the client cannot reconcile — a duplicated
 * `message_start`, a tool call emitted twice. The router surfaces the truncation instead.
 */

export interface RelayObserver {
  /** Called after the chunk is already on its way to the client. Never before. */
  onChunk?: (chunk: Uint8Array) => void
  /** The upstream stream ended cleanly. `bytes` is the total relayed. */
  onEnd?: (bytes: number) => void
  /** The upstream stream failed, or the client went away, after `bytes` had been relayed. */
  onError?: (error: unknown, bytes: number) => void
}

export function relayResponse(upstream: Response, observer: RelayObserver = {}): Response {
  const headers = clientHeaders(upstream.headers)

  if (upstream.body === null) {
    observer.onEnd?.(0)
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers })
  }

  let bytes = 0
  let settled = false
  const settle = (error: unknown): void => {
    if (settled) return
    settled = true
    if (error === undefined) observer.onEnd?.(bytes)
    else observer.onError?.(error, bytes)
  }

  const passthrough = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Enqueue first. Everything after this line happens on time the client already has.
      controller.enqueue(chunk)
      bytes += chunk.length
      try {
        observer.onChunk?.(chunk)
      } catch {
        // A broken observer degrades reporting for this request. It does not break the stream.
      }
    },
    flush() {
      settle(undefined)
    },
  })

  upstream.body.pipeTo(passthrough.writable).catch((error: unknown) => {
    settle(error)
  })

  return new Response(passthrough.readable, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
