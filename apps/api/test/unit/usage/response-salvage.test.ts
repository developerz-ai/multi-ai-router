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

test("error evidence is optional: kept when small, dropped before it can fail the salvage (#188)", () => {
  const run = (text: string, cap = 64) => {
    const scanner = createResponseSalvage(cap)
    for (const byte of encoder.encode(text)) scanner.push(byte)
    expect(scanner.retainedBytes).toBeLessThanOrEqual(cap)
    return scanner.finish()
  }
  // A small Codex error is kept, code and all.
  expect(run('{"type":"response.failed","response":{"error":{"code":"x"}}}', 256)).toEqual({
    type: "response.failed",
    response: { error: { code: "x" } },
  })
  // Usage first, then an error that would cross the cap: the error goes, the frame stays.
  expect(
    run(
      `{"type":"response.failed","response":{"usage":{"t":"${"u".repeat(30)}"},"error":{"m":"${"e".repeat(12)}"}}}`,
      64,
    ),
  ).toEqual({ type: "response.failed", response: { usage: { t: "u".repeat(30) } } })
  // An error first, then a required member that needs its room: the kept error is evicted.
  expect(
    run(
      `{"type":"response.failed","response":{"error":{"c":"${"e".repeat(6)}"},"usage":{"t":"${"u".repeat(28)}"}}}`,
      64,
    ),
  ).toEqual({ type: "response.failed", response: { usage: { t: "u".repeat(28) } } })
})

test("a repeated optional key releases the earlier capture's bytes (#188)", () => {
  const scanner = createResponseSalvage(64)
  const text = `{"code":"${"c".repeat(10)}","code":"${"d".repeat(10)}","usage":{"t":"${"u".repeat(20)}"}}`
  for (const byte of encoder.encode(text)) scanner.push(byte)
  // The kept bytes are the last `code` (12) and `usage` (28) only; unreleased, the first `code`
  // would still count, 52.
  expect(scanner.retainedBytes).toBe(40)
  expect(scanner.finish()).toEqual({ code: "d".repeat(10), usage: { t: "u".repeat(20) } })
})

test("a root key named like an Object built-in never throws (#207 review)", () => {
  const scanner = createResponseSalvage(1024)
  const text =
    '{"constructor":{"a":1},"__proto__":{"b":2},"toString":{"c":3},"usage":{"input_tokens":5}}'
  for (const byte of encoder.encode(text)) scanner.push(byte)
  expect(scanner.finish()).toEqual({ usage: { input_tokens: 5 } })
})

test("an oversized base_resp.status_code is dropped, never fails the salvage (#207 review)", () => {
  const scanner = createResponseSalvage(1024)
  const text = `{"type":"response.completed","usage":{"input_tokens":5},"base_resp":{"status_code":"${"9".repeat(2048)}"}}`
  for (const byte of encoder.encode(text)) scanner.push(byte)
  expect(scanner.retainedBytes).toBeLessThanOrEqual(1024)
  expect(scanner.finish()).toEqual({ type: "response.completed", usage: { input_tokens: 5 } })
})

test("at a tiny cap, base_resp.status_code gives way rather than failing the salvage (#207 round 3)", () => {
  for (let cap = 36; cap <= 60; cap++) {
    const scanner = createResponseSalvage(cap)
    const text = `{"usage":{"input_tokens":5,"output_tokens":3},"pad":"${"x".repeat(200)}","base_resp":{"status_code":1008}}`
    for (const byte of encoder.encode(text)) scanner.push(byte)
    const usage = '{"input_tokens":5,"output_tokens":3}'.length
    if (usage <= cap) expect(scanner.finish()).toMatchObject({ usage: { input_tokens: 5 } })
  }
})

test("a full budget drops base_resp.status_code itself rather than evicting earlier error evidence (#207 round 4)", () => {
  const scanner = createResponseSalvage(128)
  const text = `{"error":{"code":"insufficient_quota"},"type":"${"t".repeat(94)}","base_resp":{"status_code":1008},"z":"${"q".repeat(128)}"}`
  for (const byte of encoder.encode(text)) scanner.push(byte)
  expect(scanner.finish()).toEqual({ error: { code: "insufficient_quota" }, type: "t".repeat(94) })
})

test("a full 64 KiB budget evicts base_resp.status_code before the code main kept (#207 round 4)", () => {
  const cap = 65_536
  const head = '{"code":"insufficient_quota","base_resp":{"status_code":1008},"usage":{"pad":"'
  // code (20 bytes) and usage fit the cap together; with the 4-byte status code they do not.
  const fill = "u".repeat(cap - 32)
  const scanner = createResponseSalvage(cap)
  for (const byte of encoder.encode(`${head}${fill}"}}`)) scanner.push(byte)
  expect(scanner.finish()).toMatchObject({ code: "insufficient_quota", usage: { pad: fill } })
})

test("an error seen after base_resp at a full budget evicts base_resp, not itself (#207 round 5)", () => {
  const scanner = createResponseSalvage(64)
  const text = `{"usage":{"p":"${"u".repeat(50)}"},"base_resp":{"status_code":1008},"code":"q","status":"s"}`
  for (const byte of encoder.encode(text)) scanner.push(byte)
  expect(scanner.finish()).toMatchObject({ code: "q", status: "s" })
})

test("an error capture that drops anyway does not take base_resp with it (#207 round 6)", () => {
  const scanner = createResponseSalvage(64)
  const text = `{"usage":{"p":"${"u".repeat(50)}"},"base_resp":{"status_code":1008},"code":"insufficient_quota"}`
  for (const byte of encoder.encode(text)) scanner.push(byte)
  expect(scanner.retainedBytes).toBe(62)
  expect(scanner.finish()).toMatchObject({ base_resp: { status_code: 1008 } })
})

test("lent room stays with a kept capture and is not double-counted later (#207 round 7)", () => {
  const prefix = `{"usage":{"p":"${"u".repeat(50)}"},"base_resp":{"status_code":1008}`
  const kept = createResponseSalvage(64)
  for (const byte of encoder.encode(`${prefix},"code":"ab","error":"xyz"}`)) kept.push(byte)
  expect(kept.retainedBytes).toBe(62)
  expect(kept.finish()).not.toHaveProperty("base_resp")

  const dropped = createResponseSalvage(64)
  const text = `${prefix},"code":"insufficient_quota","error":"xyz"}`
  for (const byte of encoder.encode(text)) dropped.push(byte)
  expect(dropped.retainedBytes).toBe(63)
  const rebuilt = dropped.finish()
  expect(rebuilt).toMatchObject({ error: "xyz" })
  expect(rebuilt).not.toHaveProperty("base_resp")
})

test("a repeated base_resp keeps the last status code, as JSON.parse does (#207 round 7)", () => {
  const scanner = createResponseSalvage(64)
  const text = `{"base_resp":{"status_code":1008},"usage":{"p":"${"x".repeat(52)}"},"code":"${"c".repeat(40)}","base_resp":{"status_code":1002}}`
  for (const byte of encoder.encode(text)) {
    scanner.push(byte)
    expect(scanner.retainedBytes).toBeLessThanOrEqual(64)
  }
  expect(scanner.finish()).toMatchObject({ base_resp: { status_code: 1002 } })
})
