import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import {
  createRoutingScanner,
  readRequestBody,
  resolveSessionKey,
  rewriteModel,
} from "../../../src/services/dataplane"

/**
 * The passthrough body is opaque: two fields come out of it incrementally and the bytes go
 * upstream untouched. These tests pin both halves — what is extracted, and that nothing else moved.
 */

const encoder = new TextEncoder()

function scan(body: string, chunkSize = body.length) {
  const scanner = createRoutingScanner()
  const bytes = encoder.encode(body)
  for (let at = 0; at < bytes.length; at += chunkSize) {
    scanner.push(bytes.subarray(at, at + chunkSize))
  }
  return scanner.result()
}

function stream(body: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(body)
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.subarray(at, at + chunkSize))
      }
      controller.close()
    },
  })
}

describe("routing scanner", () => {
  test("finds the top-level model and its byte span", () => {
    const body = '{"model":"claude-opus-5","max_tokens":16}'
    const result = scan(body)

    expect(result.model).toBe("claude-opus-5")
    expect(body.slice(result.modelSpan?.start, result.modelSpan?.end)).toBe("claude-opus-5")
  })

  test("finds it identically however the bytes are chunked", () => {
    const body = '{"messages":[{"role":"user","content":"hi"}],"model":"gpt-5"}'
    for (const size of [1, 3, 7, 64]) {
      expect(scan(body, size).model).toBe("gpt-5")
    }
  })

  test("ignores a nested key named model — only the top level routes", () => {
    const result = scan('{"messages":[{"model":"decoy"}],"model":"real"}')
    expect(result.model).toBe("real")
  })

  test("is not fooled by a brace or a quote inside a string", () => {
    const result = scan('{"system":"a { \\" }","model":"real"}')
    expect(result.model).toBe("real")
  })

  test("captures the conversation prefix from either dialect's field", () => {
    const anthropic = scan('{"model":"m","messages":[{"role":"user","content":"alpha"}]}')
    const responses = scan('{"model":"m","input":[{"role":"user","content":"alpha"}]}')

    expect(new TextDecoder().decode(anthropic.conversationPrefix)).toContain("alpha")
    expect(new TextDecoder().decode(responses.conversationPrefix)).toContain("alpha")
  })

  test("reports nothing rather than throwing on a body that is not JSON at all", () => {
    expect(scan("not json").model).toBeNull()
  })

  test("stops once both fields are in hand", () => {
    const scanner = createRoutingScanner({ conversationPrefixBytes: 8 })
    scanner.push(encoder.encode('{"model":"m","messages":[{"role":"user"}]'))
    expect(scanner.done).toBe(true)
  })
})

describe("reading a request body", () => {
  test("returns the exact bytes the client sent, however they arrived", async () => {
    const body = '{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}]}'
    const read = await readRequestBody(stream(body, 5))

    expect(new TextDecoder().decode(read.bytes)).toBe(body)
    expect(read.fields.model).toBe("claude-opus-5")
  })

  test("refuses a body past the configured ceiling", async () => {
    const body = `{"model":"m","padding":"${"x".repeat(400)}"}`
    await expect(readRequestBody(stream(body, 32), { maxBytes: 64 })).rejects.toThrow(
      TranslationError,
    )
  })

  test("handles an absent body", async () => {
    const read = await readRequestBody(null)
    expect(read.bytes.length).toBe(0)
    expect(read.fields.model).toBeNull()
  })
})

describe("model rewriting", () => {
  test("replaces only the model's own bytes", () => {
    const body = '{"model":"sonnet","messages":[],"temperature":0.5}'
    const read = createRoutingScanner()
    read.push(encoder.encode(body))
    const span = read.result().modelSpan

    if (span === null) throw new Error("expected a model span")
    const out = new TextDecoder().decode(rewriteModel(encoder.encode(body), span, "glm-4.7"))

    expect(out).toBe('{"model":"glm-4.7","messages":[],"temperature":0.5}')
  })
})

describe("session key", () => {
  const prefix = encoder.encode('[{"role":"user","content":"first turn"}]')

  test("prefers a client-supplied session header — the client knows its own boundaries", () => {
    const headers = new Headers({ "x-session-id": "conversation-7" })
    expect(resolveSessionKey(headers, "key-1", prefix)).toEqual({
      key: "conversation-7",
      source: "header",
    })
  })

  test("fingerprints the conversation's opening bytes when no header is sent", () => {
    const resolved = resolveSessionKey(new Headers(), "key-1", prefix)
    expect(resolved.source).toBe("fingerprint")
    expect(resolved.key).toStartWith("fp_")
  })

  test("the fingerprint is stable across turns and distinct between conversations", () => {
    const turnOne = resolveSessionKey(new Headers(), "key-1", prefix).key
    const turnTwo = resolveSessionKey(new Headers(), "key-1", prefix).key
    const other = resolveSessionKey(
      new Headers(),
      "key-1",
      encoder.encode('[{"role":"user","content":"different"}]'),
    ).key

    expect(turnTwo).toBe(turnOne)
    expect(other).not.toBe(turnOne)
  })

  test("two keys never share a session, even on identical bytes", () => {
    const first = resolveSessionKey(new Headers(), "key-1", prefix).key
    const second = resolveSessionKey(new Headers(), "key-2", prefix).key
    expect(second).not.toBe(first)
  })
})
