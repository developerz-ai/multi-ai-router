import { expect, test } from "bun:test"
import { createResponseObserver } from "../../../src/services/usage"
import type { ResponseObservationSpec } from "../../../src/services/usage/response-observer-types"
import { createResponseSalvage } from "../../../src/services/usage/response-salvage"

/**
 * 07.1: the observer scans lines with `indexOf`, holds partial lines as chunk slices, and skips
 * parsing frames that cannot move a fact. These pin the split-frame and skip edges of that scanner.
 */

const encoder = new TextEncoder()
const anthropic: ResponseObservationSpec = {
  dialect: "anthropic",
  operation: "messages",
  contentType: "text/event-stream",
  maximumObservationBytes: 4096,
}

function anthropicStream(newline: string): Uint8Array {
  const frame = (name: string, body: unknown) =>
    `event: ${name}${newline}data: ${JSON.stringify(body)}${newline}${newline}`
  return encoder.encode(
    frame("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 321, output_tokens: 1, cache_read_input_tokens: 9 } },
    }) +
      frame("content_block_start", { type: "content_block_start", index: 0 }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "雪 é 🎉" },
      }) +
      frame("ping", { type: "ping" }) +
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      frame("message_delta", { type: "message_delta", usage: { output_tokens: 77 } }) +
      frame("message_stop", { type: "message_stop" }),
  )
}

/** Feeds `bytes` cut at two points, so every split of a line, a CRLF, and a UTF-8 char is hit. */
function everyThreeWaySplit(bytes: Uint8Array, check: (chunks: Uint8Array[]) => void) {
  for (let first = 0; first <= bytes.length; first += 3)
    for (let second = first; second <= bytes.length; second += 5)
      check([bytes.slice(0, first), bytes.slice(first, second), bytes.slice(second)])
}

for (const [label, newline] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
] as const) {
  test(`${label}: any split — inside "data:", a CRLF pair, or a multi-byte char — reads the same facts`, () => {
    const bytes = anthropicStream(newline)
    everyThreeWaySplit(bytes, (chunks) => {
      const observer = createResponseObserver(anthropic)
      for (const chunk of chunks) observer.observe(chunk)
      const facts = observer.finish()
      expect(facts.counts).toEqual({
        tokensIn: 321,
        tokensOut: 77,
        cacheReadTokens: 9,
        cacheWriteTokens: 0,
      })
      expect(facts.terminal).toBe("completed")
      expect(facts.evidenceUnavailable).toBe(false)
    })
  })
}

test("a multi-byte char split one byte at a time decodes once the line completes", () => {
  const observer = createResponseObserver({ ...anthropic, dialect: "openai-chat" })
  const bytes = encoder.encode(
    'data: {"x":"🎉","usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
  )
  for (const byte of bytes) observer.observe(Uint8Array.of(byte))
  expect(observer.finish()).toMatchObject({ counts: { tokensIn: 5 }, evidenceUnavailable: false })
})

test("content events are not parsed, yet message_delta usage is still read", () => {
  const parsed: (string | undefined)[] = []
  const observer = createResponseObserver({
    ...anthropic,
    // A hook that declares it ignores content frames: they are skipped before decoding.
    descriptor: {
      terminalPolicy: "evidence-only",
      contentFrames: "skip",
      inspectPayload: (_payload, event) => {
        parsed.push(event)
        return null
      },
    },
  })
  observer.observe(anthropicStream("\n"))
  const facts = observer.finish()
  expect(parsed).toEqual(["message_start", "message_delta", "message_stop"])
  expect(facts.counts.tokensOut).toBe(77)
  expect(facts.terminal).toBe("completed")
})

test("a skipped content event that is malformed costs nothing; one that is not skipped still counts", () => {
  const observer = createResponseObserver(anthropic)
  observer.observe(encoder.encode("event: content_block_delta\ndata: {not json\n\n"))
  expect(observer.snapshot().evidenceUnavailable).toBe(false)
  observer.observe(encoder.encode("event: message_delta\ndata: {not json\n\n"))
  expect(observer.snapshot().evidenceUnavailable).toBe(true)
})

test("an inspectPayload hook without contentFrames still sees every frame", () => {
  const seen: (string | undefined)[] = []
  const observer = createResponseObserver({
    ...anthropic,
    descriptor: {
      terminalPolicy: "evidence-only",
      inspectPayload: (_payload, event) => {
        seen.push(event)
        return null
      },
    },
  })
  observer.observe(anthropicStream("\n"))
  observer.finish()
  expect(seen).toContain("content_block_delta")
  expect(seen).toContain("ping")
  expect(seen).toHaveLength(7)
})

test("contentFrames is read per frame, so a wrapper can stop needing deltas mid-stream", () => {
  let mode: "inspect" | "skip" = "inspect"
  const seen: (string | undefined)[] = []
  const observer = createResponseObserver({
    ...anthropic,
    descriptor: {
      terminalPolicy: "evidence-only",
      get contentFrames() {
        return mode
      },
      inspectPayload: (_payload, event) => {
        seen.push(event)
        if (event === "content_block_delta") mode = "skip"
        return null
      },
    },
  })
  const delta = 'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'
  observer.observe(encoder.encode(delta + delta + delta))
  expect(seen).toEqual(["content_block_delta"])
})

test("openai-chat content chunks without a usage/error marker skip the parse; the usage chunk does not", () => {
  const observer = createResponseObserver({ ...anthropic, dialect: "openai-chat" })
  observer.observe(
    encoder.encode(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n' +
        "data: [DONE]\n\n",
    ),
  )
  expect(observer.finish()).toMatchObject({
    counts: { tokensIn: 12, tokensOut: 3 },
    terminal: "completed",
  })
})

test("an onPayload tap sees every parsed frame and keeps content frames parsed", () => {
  const tapped: (string | undefined)[] = []
  const observer = createResponseObserver({
    ...anthropic,
    onPayload: (_payload, event) => tapped.push(event),
  })
  observer.observe(anthropicStream("\n"))
  expect(observer.finish().counts.tokensOut).toBe(77)
  expect(tapped).toHaveLength(7)
})

test("snapshot is the same object until a frame lands; terminal/failure read live", () => {
  const observer = createResponseObserver({ ...anthropic, dialect: "openai-chat" })
  const before = observer.snapshot()
  const revision = observer.revision
  observer.observe(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n'))
  expect(observer.snapshot()).toBe(before)
  expect(observer.revision).toBe(revision)
  observer.observe(encoder.encode('\ndata: {"error":{"message":"boom"}}\n\n'))
  expect(observer.revision).toBeGreaterThan(revision)
  expect(observer.terminal).toBe("explicit_error")
  expect(observer.failure?.kind).toBe("server-error")
  const after = observer.snapshot()
  expect(after).not.toBe(before)
  expect(after.terminal).toBe("explicit_error")
})

test("a JSON body held as chunk copies is unaffected by the caller reusing its buffer", () => {
  const observer = createResponseObserver({ ...anthropic, contentType: "application/json" })
  const body = encoder.encode('{"type":"message","usage":{"input_tokens":4,"output_tokens":2}}')
  const reused = new Uint8Array(body.length)
  reused.set(body)
  observer.observe(reused.subarray(0, 20))
  reused.fill(0, 0, 20)
  reused.set(body.subarray(20), 20)
  observer.observe(reused.subarray(20))
  expect(observer.finish().counts).toMatchObject({ tokensIn: 4, tokensOut: 2 })
})

/** Strings with escapes, nested slots and noise, so the string fast-skip meets every edge. */
function randomDocument(seed: number): string {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) >>> 0
    return state / 2 ** 32
  }
  const pieces = ['\\"', "\\\\", "\\u0041", "x", "雪", "\\n", '"', "\\"]
  const string = () => {
    let out = ""
    for (let i = Math.floor(next() * 12); i > 0; i--) {
      const piece = pieces[Math.floor(next() * (pieces.length - 2))] ?? "x"
      out += piece
    }
    return `"${out}"`
  }
  const members = [
    `"pad":${string()}`,
    `"type":${string()}`,
    `"usage":{"input_tokens":${Math.floor(next() * 1000)},"note":${string()}}`,
    `"error":{"message":${string()},"code":${string()}}`,
    `"list":[${string()},{"deep":${string()}},12.5]`,
  ]
  return `{${members.sort(() => next() - 0.5).join(",")}}`
}

test("pushChunk over any split reads exactly what per-byte push reads", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const bytes = encoder.encode(randomDocument(seed))
    const byByte = createResponseSalvage(4096)
    for (const byte of bytes) byByte.push(byte)
    const expected = byByte.finish()
    for (const step of [1, 3, 7, 64, bytes.length]) {
      const chunked = createResponseSalvage(4096)
      for (let at = 0; at < bytes.length; at += step)
        chunked.pushChunk(bytes, at, Math.min(bytes.length, at + step))
      expect(chunked.finish()).toEqual(expected)
      expect(chunked.retainedBytes).toBe(byByte.retainedBytes)
    }
  }
})
