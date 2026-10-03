import { expect, test } from "bun:test"
import { createResponseObserver } from "../../../src/services/usage"

const encoder = new TextEncoder()
const spec = {
  dialect: "openai-chat",
  operation: "messages",
  contentType: "text/event-stream",
  maximumObservationBytes: 1024,
} as const

test("every UTF8/CRLF/numeric split observes only a complete multiline SSE frame", () => {
  const bytes = encoder.encode(
    'event: message\r\ndata: {"content":"雪",\r\ndata: "usage":{"prompt_tokens":12345,"completion_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n',
  )
  for (let at = 0; at <= bytes.length; at++) {
    const observer = createResponseObserver(spec)
    observer.observe(bytes.slice(0, at))
    observer.observe(bytes.slice(at))
    const facts = observer.finish()
    expect(facts.counts.tokensIn).toBe(12345)
    expect(facts.counts.tokensOut).toBe(7)
    expect(facts.evidenceUnavailable).toBe(false)
    expect(facts.terminal).toBe("completed")
  }
})
test("content bytes can be forwarded before complete event observation; a number prefix never counts", () => {
  const observer = createResponseObserver(spec)
  const first = encoder.encode('data: {"usage":{"prompt_tokens":12')
  observer.observe(first)
  expect(observer.snapshot().counts.tokensIn).toBe(0)
  observer.observe(encoder.encode("345}}\n\n"))
  expect(observer.snapshot().counts.tokensIn).toBe(12345)
})
test("oversized lines/events discard to boundary, stay bounded, and recover later valid frames", () => {
  for (const oversized of [
    `data: ${"x".repeat(200)}\n\n`,
    `${'data: "12345678901234567890"\n'.repeat(8)}\n`,
  ]) {
    const observer = createResponseObserver({ ...spec, maximumObservationBytes: 96 })
    for (const byte of encoder.encode(oversized)) {
      observer.observe(Uint8Array.of(byte))
      expect(observer.retainedBytes).toBeLessThanOrEqual(96)
    }
    observer.observe(encoder.encode('data: {"usage":{"prompt_tokens":8}}\n\n'))
    const facts = observer.finish()
    expect(facts.counts.tokensIn).toBe(8)
    expect(facts.evidenceUnavailable).toBe(true)
    expect(observer.retainedBytes).toBe(0)
  }
})
test("bounded nonstream JSON flushes once at EOF and does not accept unfinished or oversized evidence", () => {
  const body = encoder.encode('{"usage":{"prompt_tokens":12345},"content":"雪"}')
  for (let split = 0; split <= body.length; split++) {
    const observer = createResponseObserver({ ...spec, contentType: "application/json" })
    observer.observe(body.slice(0, split))
    expect(observer.snapshot().counts.tokensIn).toBe(0)
    observer.observe(body.slice(split))
    expect(observer.finish().counts.tokensIn).toBe(12345)
    observer.observe(encoder.encode("garbage"))
    expect(observer.finish().counts.tokensIn).toBe(12345)
  }
  for (const text of ['{"usage":', "x".repeat(1025)]) {
    const observer = createResponseObserver({ ...spec, contentType: "application/json" })
    observer.observe(encoder.encode(text))
    expect(observer.finish().evidenceUnavailable).toBe(true)
    expect(observer.finish().counts.tokensIn).toBe(0)
  }
})
test("unterminated SSE and malformed UTF8 are unavailable rather than missing-terminal proof", () => {
  const observer = createResponseObserver({
    ...spec,
    descriptor: { terminalPolicy: "require-completion" },
  })
  observer.observe(encoder.encode('data: {"usage":{"prompt_tokens":8}}'))
  expect(observer.finish()).toMatchObject({
    evidenceUnavailable: true,
    failure: null,
    terminal: "none",
  })
  const utf8 = createResponseObserver(spec)
  utf8.observe(Uint8Array.from([100, 97, 116, 97, 58, 32, 255, 10, 10]))
  expect(utf8.finish().evidenceUnavailable).toBe(true)
})
