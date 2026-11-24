/**
 * A response body watched, never touched: each chunk is read when the client asks and handed on as it
 * came. One read and one enqueue per chunk, where a `TransformStream` costs a queue on each side.
 */
export interface BodyObserver {
  /** The first chunk is on its way. */
  onFirst?: () => void
  /** Every way out, exactly once. */
  onEnd(how: "end" | "cancelled" | "broken"): void
}

export function observeBody(
  body: ReadableStream<Uint8Array>,
  observer: BodyObserver,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let first = true
  let over = false
  const leave = (how: "end" | "cancelled" | "broken"): void => {
    if (over) return
    over = true
    observer.onEnd(how)
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (error) {
          leave("broken")
          throw error
        }
        if (next.done) {
          leave("end")
          controller.close()
          return
        }
        controller.enqueue(next.value)
        if (!first) return
        first = false
        observer.onFirst?.()
      },
      async cancel(reason) {
        leave("cancelled")
        await reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
