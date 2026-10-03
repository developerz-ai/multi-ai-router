import { expect, test } from "bun:test"
import { RouterShutdownError } from "../../../src/services/dataplane/active-requests"
import { ClientCancelledError } from "../../../src/services/dataplane/relay-cancellation"
import { relayTranslatedResponse } from "../../../src/services/dataplane/relay-translate"
import { translationPair } from "../../../src/services/translate/registry"

for (const cause of ["client", "shutdown"] as const) {
  test(`nonstream translated ${cause} stops a held upstream read without completion`, async () => {
    let cancellation: unknown
    const errors: unknown[] = []
    let completed = 0
    let chunks = 0
    const abort = new AbortController()
    const pair = translationPair("openai-chat", "anthropic")
    if (pair === null) throw new Error("missing translator")
    const response = relayTranslatedResponse({
      upstream: new Response(
        new ReadableStream<Uint8Array>({
          cancel(reason) {
            cancellation = reason
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      pair,
      context: { created: 0, model: "offline", fallbackId: "offline" },
      signal: abort.signal,
      observer: {
        onEnd: () => {
          completed++
        },
        onChunk: () => {
          chunks++
        },
        onError: (error) => {
          errors.push(error)
        },
      },
    })
    if (response.body === null) throw new Error("missing response")
    const reader = response.body.getReader()
    if (cause === "client") await reader.cancel()
    else {
      abort.abort(new RouterShutdownError())
      await reader.read().catch(() => {})
    }
    await Promise.resolve()
    expect(response.status).toBe(200)
    expect(cancellation).toBeInstanceOf(
      cause === "client" ? ClientCancelledError : RouterShutdownError,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(
      cause === "client" ? ClientCancelledError : RouterShutdownError,
    )
    expect({ completed, chunks }).toEqual({ completed: 0, chunks: 0 })
  })
}
