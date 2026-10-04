import { expect, test } from "bun:test"
import { fingerprintSessionKey, readRequestBody } from "../../../src/services/dataplane/body/read"
import {
  createRoutingScanner,
  DEFAULT_CONVERSATION_PREFIX_BYTES,
} from "../../../src/services/dataplane/body/scanner"

const encoder = new TextEncoder(),
  decoder = new TextDecoder()

test("bounded opening capture still validates the suffix through explicit EOF", () => {
  const opening = `{"role":"user","content":"${"x".repeat(280000)}"}`
  const text = `{"model":"claude","messages":[${opening}]}`
  const bytes = encoder.encode(text),
    start = text.indexOf(opening),
    cut = start + DEFAULT_CONVERSATION_PREFIX_BYTES
  const scanner = createRoutingScanner()
  scanner.push(bytes.subarray(0, cut))
  expect(scanner.done).toBe(false)
  scanner.push(bytes.subarray(cut))
  const result = scanner.finish()
  expect(result.invalid).toBe(false)
  expect(result.model).toBe("claude")
  expect(result.conversationPrefix).toEqual(
    bytes.subarray(start, start + DEFAULT_CONVERSATION_PREFIX_BYTES),
  )
  const ambiguous = createRoutingScanner()
  ambiguous.push(encoder.encode(text.slice(0, -1) + ',"model":"other"}'))
  expect(ambiguous.finish().duplicateModel).toBe(true)
})

test("a model after huge content retains its exact absolute alias-rewrite span", () => {
  const opening = `{"role":"user","content":"${"x".repeat(280000)}"}`
  const text = `{"messages":[${opening}],"model":"claude-after"}`,
    bytes = encoder.encode(text),
    cut = 200000
  const scanner = createRoutingScanner()
  scanner.push(bytes.subarray(0, cut))
  expect(scanner.done).toBe(false)
  scanner.push(bytes.subarray(cut))
  const result = scanner.finish()
  expect(result.invalid).toBe(false)
  expect(result.model).toBe("claude-after")
  expect(result.modelSpan).toEqual({
    start: text.lastIndexOf("claude-after"),
    end: text.lastIndexOf("claude-after") + "claude-after".length,
  })
  expect(decoder.decode(bytes.subarray(result.modelSpan?.start, result.modelSpan?.end))).toBe(
    "claude-after",
  )
  expect(result.conversationPrefix).toEqual(
    bytes.subarray(
      text.indexOf(opening),
      text.indexOf(opening) + DEFAULT_CONVERSATION_PREFIX_BYTES,
    ),
  )
})

test("escaped and UTF8 opening fingerprints remain identical across every byte split", () => {
  const opening = JSON.stringify({ role: "user", content: '雪"\\🙂'.repeat(20) })
  const text = `{"model":"claude","messages":[${opening}]}`,
    bytes = encoder.encode(text),
    start = bytes.indexOf(123, bytes.indexOf(91))
  for (const prefixBytes of [27, 28, 29, 30, 31, 32]) {
    const expected = bytes.subarray(start, start + prefixBytes),
      fingerprint = fingerprintSessionKey("offline-key", expected)
    for (let split = 0; split <= bytes.length; split++) {
      const scanner = createRoutingScanner({ conversationPrefixBytes: prefixBytes })
      scanner.push(bytes.subarray(0, split))
      scanner.push(bytes.subarray(split))
      expect(scanner.done).toBe(false)
      const result = scanner.finish()
      expect(result.invalid).toBe(false)
      expect(result.model).toBe("claude")
      expect(fingerprintSessionKey("offline-key", result.conversationPrefix)).toBe(fingerprint)
    }
  }
})

test("appended turns keep only the first usable user item, excluding leading system items", () => {
  const user = { content: "hello", role: "user" },
    system = { role: "system", content: "instructions" }
  const scan = (messages: unknown[]) => {
    const scanner = createRoutingScanner()
    scanner.push(encoder.encode(JSON.stringify({ model: "m", messages })))
    return scanner.finish()
  }
  const one = scan([system, user]),
    next = scan([
      system,
      user,
      { role: "assistant", content: "hi" },
      { role: "user", content: "next" },
    ])
  expect(decoder.decode(one.conversationPrefix)).toBe(JSON.stringify(user))
  expect(next.conversationPrefix).toEqual(one.conversationPrefix)
  expect(scan([{ role: "assistant", content: "no opening user" }]).conversationPrefix.length).toBe(
    0,
  )
})

function sourceChunks(chunks: readonly Uint8Array[]) {
  return {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
  }
}
test("assembled request bytes and routing evidence agree across every offset UTF8 split", async () => {
  const bytes = encoder.encode(
    JSON.stringify({ model: "claude", messages: [{ role: "user", content: "雪😀é\ud800\ufeff" }] }),
  )
  for (let split = 0; split <= bytes.length; split++) {
    const left = new Uint8Array(split + 7).fill(255)
    left.set(bytes.subarray(0, split), 3)
    const right = new Uint8Array(bytes.length - split + 9).fill(254)
    right.set(bytes.subarray(split), 5)
    const read = await readRequestBody(
      sourceChunks([
        new Uint8Array(),
        left.subarray(3, 3 + split),
        right.subarray(5, 5 + bytes.length - split),
        new Uint8Array(),
      ]),
    )
    expect(Array.from(read.bytes)).toEqual(Array.from(bytes))
    expect(read.fields.invalid).toBe(false)
    expect(read.fields.model).toBe("claude")
  }
  const trailing = encoder.encode('{"model":"claude"} trailing')
  const read = await readRequestBody(sourceChunks([trailing.subarray(0, 8), trailing.subarray(8)]))
  expect(Array.from(read.bytes)).toEqual(Array.from(trailing))
  expect(read.fields.invalid).toBe(true)
})
test("single request chunk retains identity; assembled chunks retain independent byte lifetime", async () => {
  const bytes = encoder.encode('{"model":"claude","messages":[]}')
  expect((await readRequestBody(sourceChunks([bytes]))).bytes).toBe(bytes)
  const first = bytes.slice(0, 7),
    second = bytes.slice(7)
  const read = await readRequestBody(sourceChunks([first, second])),
    saved = Array.from(read.bytes)
  first.fill(0)
  second.fill(0)
  await readRequestBody(sourceChunks([encoder.encode('{"model":'), encoder.encode('"other"}')]))
  expect(Array.from(read.bytes)).toEqual(saved)
})
