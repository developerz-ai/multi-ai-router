import { expect, test } from "bun:test"
import { relayTranslatedResponse } from "../../../src/services/dataplane/relay-translate"
import { translationPair } from "../../../src/services/translate/registry"

for (const emitted of ["forwarded-comment", "synthetic-heartbeat"] as const) {
  for (const ending of ["error", "clean"] as const) {
    test(`${emitted} ${ending} counts actual wire bytes without content TTFB`, async () => {
      const pair = translationPair("openai-chat", "anthropic")
      if (pair === null) throw new Error("missing translator")
      let source: ReadableStreamDefaultController<Uint8Array> | undefined
      let clock = 0
      let firstContent = 0
      const endings: number[] = []
      const wire: number[] = []
      const response = relayTranslatedResponse({
        upstream: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
        pair,
        context: { created: 0, model: "offline", fallbackId: "offline" },
        now: () => clock,
        keepaliveMs: 5,
        observer: {
          onWireBytes: (bytes) => {
            wire.push(bytes)
          },
          onFirstByte: () => {
            firstContent++
          },
          onEnd: (bytes) => {
            endings.push(bytes)
          },
          onError: (_error, bytes) => {
            endings.push(bytes)
          },
        },
      })
      if (source === undefined || response.body === null) throw new Error("missing stream")
      const reader = response.body.getReader()
      clock = 10
      source.enqueue(
        new TextEncoder().encode(
          emitted === "forwarded-comment"
            ? ": heartbeat\n\n"
            : 'event: ping\ndata: {"type":"ping"}\n\n',
        ),
      )
      const chunk = await reader.read()
      expect(new TextDecoder().decode(chunk.value)).toBe(
        emitted === "forwarded-comment" ? ": heartbeat\n\n" : ":\n\n",
      )
      expect(firstContent).toBe(0)
      expect(wire).toEqual([chunk.value?.length])
      if (ending === "error") source.error(new Error("offline stream failure"))
      else source.close()
      // A stream that said nothing but keepalives ends with the router's error event; a broken one
      // errors. Either way every byte on the wire is counted, and none of it is content.
      const last = await reader.read().catch(() => undefined)
      const total = (chunk.value?.length ?? 0) + (last?.value?.length ?? 0)
      expect((last?.value?.length ?? 0) > 0).toBe(ending === "clean")
      expect(endings).toEqual([total])
      expect(firstContent).toBe(0)
    })
  }
}
