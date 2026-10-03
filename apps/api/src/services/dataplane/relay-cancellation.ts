/** A downstream cancellation is not evidence that an upstream account failed. */
export class ClientCancelledError extends Error {
  constructor() {
    super("client cancelled the response")
    this.name = "ClientCancelledError"
  }
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
