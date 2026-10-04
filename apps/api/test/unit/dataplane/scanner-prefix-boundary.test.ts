import { expect, test } from "bun:test"
import { fingerprintSessionKey } from "../../../src/services/dataplane/body/read"
import {
  createRoutingScanner,
  DEFAULT_CONVERSATION_PREFIX_BYTES,
} from "../../../src/services/dataplane/body/scanner"

const encoder = new TextEncoder(),
  decoder = new TextDecoder()
function observed(bytes: Uint8Array, unreadFrom?: number) {
  let reads = 0
  return {
    get reads() {
      return reads
    },
    bytes: new Proxy(bytes, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads++
          if (unreadFrom !== undefined && Number(key) >= unreadFrom)
            throw new Error("scanner touched a suffix after routing fields were complete")
        }
        return Reflect.get(target, key, target)
      },
    }),
  }
}

test("known model plus full fingerprint stops inside one huge text string without reading the unused suffix", () => {
  const text = `{"model":"claude","messages":[{"role":"user","content":"${"x".repeat(280000)}`
  const bytes = encoder.encode(text)
  const start = text.indexOf("[")
  const prefixEnd = start + DEFAULT_CONVERSATION_PREFIX_BYTES
  const tracked = observed(bytes, prefixEnd)
  const scanner = createRoutingScanner()
  scanner.push(tracked.bytes)
  expect(scanner.done).toBe(true)
  expect(scanner.result().model).toBe("claude")
  expect(scanner.result().conversationPrefix).toEqual(bytes.subarray(start, prefixEnd))
  expect(tracked.reads).toBe(prefixEnd)
  // Later body chunks still pass through the body reader; the completed scanner learns nothing else.
  scanner.push(observed(encoder.encode('"}]}'), 0).bytes)
  expect(scanner.result().conversationPrefix).toEqual(bytes.subarray(start, prefixEnd))
})

test("a model after huge content is still found with its exact absolute alias-rewrite span", () => {
  const text = `{"messages":[{"role":"user","content":"${"x".repeat(280000)}"}],"model":"claude-after"}`
  const bytes = encoder.encode(text)
  const cut = 200000
  const scanner = createRoutingScanner()
  scanner.push(bytes.subarray(0, cut))
  expect(scanner.done).toBe(false)
  scanner.push(bytes.subarray(cut))
  const result = scanner.result()
  expect(result.model).toBe("claude-after")
  expect(result.modelSpan).toEqual({
    start: text.lastIndexOf("claude-after"),
    end: text.lastIndexOf("claude-after") + "claude-after".length,
  })
  expect(decoder.decode(bytes.subarray(result.modelSpan?.start, result.modelSpan?.end))).toBe(
    "claude-after",
  )
  expect(result.conversationPrefix).toEqual(
    bytes.subarray(text.indexOf("["), text.indexOf("[") + DEFAULT_CONVERSATION_PREFIX_BYTES),
  )
})

test("escaped and UTF8 conversation fingerprints remain identical across every byte split", () => {
  const text = JSON.stringify({
    model: "claude",
    messages: [{ role: "user", content: '雪"\\🙂'.repeat(20) }],
  })
  const bytes = encoder.encode(text)
  const conversationStart = bytes.indexOf(91)
  for (const prefixBytes of [27, 28, 29, 30, 31, 32]) {
    const expected = bytes.subarray(conversationStart, conversationStart + prefixBytes)
    const fingerprint = fingerprintSessionKey("offline-key", expected)
    for (let split = 0; split <= bytes.length; split++) {
      const scanner = createRoutingScanner({ conversationPrefixBytes: prefixBytes })
      scanner.push(bytes.subarray(0, split))
      scanner.push(bytes.subarray(split))
      expect(scanner.done).toBe(true)
      const result = scanner.result()
      expect(result.model).toBe("claude")
      expect(fingerprintSessionKey("offline-key", result.conversationPrefix)).toBe(fingerprint)
    }
  }
})
