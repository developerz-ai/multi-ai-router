import { expect, test } from "bun:test"
import { relayResponse } from "../../../src/services/dataplane/relay"
import { createResponseObserver } from "../../../src/services/usage"

const encoder = new TextEncoder()
test("actual relay forwards partial event immediately and preserves HTTP200 explicit-error bytes", async () => {
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const observer = createResponseObserver({
    dialect: "openai-chat",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 1024,
  })
  const response = relayResponse(
    new Response(stream.readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    {
      onChunk: (chunk) => observer.observe(chunk),
      onEnd: () => {
        observer.finish()
      },
    },
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error("fixture response has no body")
  const first = encoder.encode('data: {"error":{"message":"opaque upstream')
  const firstWrite = writer.write(first)
  const part = await reader.read()
  expect(part.value).toEqual(first)
  expect(observer.snapshot().failure).toBeNull()
  await firstWrite
  const second = encoder.encode(' text"}}\n\n')
  const secondWrite = writer.write(second)
  expect((await reader.read()).value).toEqual(second)
  await secondWrite
  const closing = writer.close()
  expect((await reader.read()).done).toBe(true)
  await closing
  expect(response.status).toBe(200)
  expect(observer.finish().terminal).toBe("explicit_error")
  expect(observer.finish().failure?.kind).toBe("server-error")
})
