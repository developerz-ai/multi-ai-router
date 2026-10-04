import { expect, test } from "bun:test"
import { createResponseObserver } from "../../../src/services/usage"
import { createResponseSalvage } from "../../../src/services/usage/response-salvage"

/**
 * Prod v2.19.1: a Codex `response.completed` echoes instructions, tools and output (~224 KB),
 * so the event exceeded the 64 KB observation cap and its `usage` was never read — the row
 * landed as success with 0/0 tokens. Over-cap frames are now salvaged in a bounded scan.
 */

const encoder = new TextEncoder()
const CAP = 65_536
const PADDING = "x".repeat(200_000)

function feed(observer: ReturnType<typeof createResponseObserver>, text: string, step = 4096) {
  const bytes = encoder.encode(text)
  let peak = 0
  for (let at = 0; at < bytes.length; at += step) {
    observer.observe(bytes.subarray(at, at + step))
    peak = Math.max(peak, observer.retainedBytes)
  }
  return peak
}

function codexCompleted(): string {
  const response = {
    id: "resp_1",
    object: "response",
    status: "completed",
    instructions: PADDING,
    tools: [{ type: "function", name: "Read", description: "r".repeat(20_000), parameters: {} }],
    output: [
      { type: "message", content: [{ type: "output_text", text: '"usage":{"input_tokens":1}' }] },
    ],
    usage: {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 34,
      output_tokens_details: { reasoning_tokens: 4 },
      total_tokens: 1234,
    },
    metadata: { usage: { input_tokens: 9 } },
  }
  return `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 9, response })}\n\n`
}

test("oversized Codex response.completed still yields usage and completion, bounded", () => {
  const observer = createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: CAP,
    descriptor: { terminalPolicy: "require-completion" },
  })
  const created = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { status: "in_progress" } })}\n\n`
  const peak = feed(observer, created + codexCompleted())
  expect(peak).toBeLessThanOrEqual(CAP)
  const facts = observer.finish()
  expect(facts.counts).toEqual({
    tokensIn: 1000,
    tokensOut: 34,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
  })
  expect(facts).toMatchObject({ terminal: "completed", evidenceUnavailable: false, failure: null })
  expect(observer.retainedBytes).toBe(0)
})

test("every chunk split of an oversized event salvages the same usage", () => {
  const text = `data: ${JSON.stringify({ type: "message_delta", pad: "p".repeat(300), usage: { output_tokens: 77 } })}\n\n`
  const bytes = encoder.encode(text)
  for (let split = 0; split <= bytes.length; split++) {
    const observer = createResponseObserver({
      dialect: "anthropic",
      operation: "messages",
      contentType: "text/event-stream",
      maximumObservationBytes: 128,
    })
    observer.observe(bytes.slice(0, split))
    observer.observe(bytes.slice(split))
    expect(observer.finish().counts.tokensOut).toBe(77)
  }
})

test("oversized Anthropic message_start keeps message.usage across multiline data", () => {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude",
    stop_reason: null,
    container: { blob: PADDING },
    usage: { input_tokens: 4321, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
  }
  const json = JSON.stringify({ type: "message_start", message }, null, 1)
  const data = json
    .split("\n")
    .map((part) => `data: ${part}`)
    .join("\n")
  const observer = createResponseObserver({
    dialect: "anthropic",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: CAP,
  })
  const peak = feed(
    observer,
    `event: message_start\n${data}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
    997,
  )
  expect(peak).toBeLessThanOrEqual(CAP)
  const facts = observer.finish()
  expect(facts.counts).toEqual({
    tokensIn: 4321,
    tokensOut: 12,
    cacheReadTokens: 100,
    cacheWriteTokens: 7,
  })
  expect(facts).toMatchObject({ terminal: "completed", evidenceUnavailable: false })
})

test("oversized chat chunk and oversized non-stream JSON are salvaged", () => {
  const chat = createResponseObserver({
    dialect: "openai-chat",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 1024,
  })
  feed(
    chat,
    `data: ${JSON.stringify({ choices: [{ delta: { content: PADDING } }], usage: { prompt_tokens: 50, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
  )
  expect(chat.finish()).toMatchObject({
    counts: { tokensIn: 50, tokensOut: 6 },
    terminal: "completed",
    evidenceUnavailable: false,
  })
  const collected = createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "application/json",
    maximumObservationBytes: 1024,
  })
  const peak = feed(
    collected,
    JSON.stringify({
      object: "response",
      instructions: PADDING,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 10, output_tokens: 3 },
    }),
  )
  expect(peak).toBeLessThanOrEqual(1024)
  expect(collected.finish()).toMatchObject({
    counts: { tokensIn: 10, tokensOut: 3 },
    terminal: "explicit_incomplete",
    incompleteReason: "max_output_tokens",
  })
})

test("salvage fails closed: truncated, non-object, trailing junk, oversized usage", () => {
  const run = (text: string, cap = 64) => {
    const scanner = createResponseSalvage(cap)
    for (const byte of encoder.encode(text)) scanner.push(byte)
    expect(scanner.retainedBytes).toBeLessThanOrEqual(cap)
    return scanner.finish()
  }
  expect(run('{"usage":{"input_tokens":5}')).toBeNull()
  expect(run('{"usage":{"input_tokens":5},"x":"unterminated')).toBeNull()
  expect(run('"usage"')).toBeNull()
  expect(run('{"usage":{"input_tokens":5}} {"a":1}')).toBeNull()
  expect(run(`{"usage":{"input_tokens":5,"pad":"${"y".repeat(100)}"}}`)).toBeNull()
  expect(run('{"usage":{"input_tokens":5},"usage_x":1,"type":"t"}')).toEqual({
    usage: { input_tokens: 5 },
    type: "t",
  })
  // Keys nested deeper, or inside strings, never match a shallow slot.
  expect(run('{"a":{"b":{"usage":1}},"s":"\\"usage\\":2","usage":null}')).toEqual({ usage: null })
  expect(run('{"error":{"message":"long"},"type":"error"}')).toEqual({ error: {}, type: "error" })
})

test("an oversized non-JSON SSE frame stays unavailable and later frames recover", () => {
  const observer = createResponseObserver({
    dialect: "openai-chat",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 96,
  })
  feed(observer, `data: ${"x".repeat(500)}\n\ndata: {"usage":{"prompt_tokens":8}}\n\n`, 7)
  const facts = observer.finish()
  expect(facts.counts.tokensIn).toBe(8)
  expect(facts.evidenceUnavailable).toBe(true)
})
