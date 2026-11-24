import { relayCancellationError } from "./relay-cancellation"

/**
 * The one stream between an upstream body and the client's, pulled on demand.
 *
 * A relay used to be four of them — `pipeTo` into a `TransformStream`, a reader over that to notice a
 * cancel, another to end a broken stream with an event — at about 2.5 µs per chunk for work that is
 * one read and one enqueue. Pulled, never pushed: the upstream is read only when the client asks, so
 * nothing is buffered (non-negotiable 8), and every way out — end, failure, abort, cancel — is told
 * to the caller exactly once.
 */
export interface PumpHandlers {
  /** Hands one upstream chunk on. `false` when it produced nothing for the client: read another. */
  chunk(chunk: Uint8Array, controller: ReadableStreamDefaultController<Uint8Array>): boolean
  /** The upstream ended cleanly; whatever is still owed is enqueued here. */
  end(controller: ReadableStreamDefaultController<Uint8Array>): void
  /** The upstream broke, `chunk`/`end` threw, or the signal aborted (the error says who by). */
  failed(error: unknown): void
  /** The client's side was cancelled, with the error that describes it. */
  cancelled(error: Error): void
  /** Bytes that end a broken stream instead of erroring it, when there is anyone to tell. */
  lastWords?(error: unknown): Uint8Array | undefined
}

export function pumpBody(
  source: ReadableStream<Uint8Array>,
  handlers: PumpHandlers,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let over = false
  let onAbort = (): void => {}
  /** The single exit: only the first call is an outcome. */
  const leave = (): boolean => {
    if (over) return false
    over = true
    signal?.removeEventListener("abort", onAbort)
    return true
  }
  const fail = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: unknown,
    cancelSource: boolean,
  ): void => {
    if (!leave()) return
    if (cancelSource) void reader.cancel(error).catch(() => {})
    handlers.failed(error)
    const last = handlers.lastWords?.(error)
    if (last === undefined) {
      controller.error(error)
      return
    }
    controller.enqueue(last)
    controller.close()
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (signal === undefined) return
        onAbort = () => fail(controller, relayCancellationError(signal), true)
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      },
      async pull(controller) {
        for (;;) {
          let next: Awaited<ReturnType<typeof reader.read>>
          try {
            next = await reader.read()
          } catch (error) {
            fail(controller, error, false)
            return
          }
          if (over) return
          try {
            if (next.done) {
              handlers.end(controller)
              if (leave()) controller.close()
              return
            }
            if (handlers.chunk(next.value, controller)) return
          } catch (error) {
            fail(controller, error, true)
            return
          }
        }
      },
      async cancel(reason) {
        if (leave()) handlers.cancelled(relayCancellationError(signal))
        await reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
