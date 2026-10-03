import { expect, test } from "bun:test"
import type { ResponseObservationSpec } from "../../../src/services/usage"
import { createResponseObserver } from "../../../src/services/usage"

const encoder = new TextEncoder()
function json(dialect: ResponseObservationSpec["dialect"], text: string) {
  const observer = createResponseObserver({
    dialect,
    operation: "messages",
    contentType: "application/json",
    maximumObservationBytes: 4096,
  })
  observer.observe(encoder.encode(text))
  return observer.finish()
}
test("inclusive Chat/Responses cache is subtracted once; Anthropic input is already uncached", () => {
  expect(
    json(
      "openai-responses",
      '{"usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":40}}}',
    ).counts,
  ).toEqual({ tokensIn: 60, tokensOut: 5, cacheReadTokens: 40, cacheWriteTokens: 0 })
  expect(
    json(
      "openai-chat",
      '{"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":40}}}',
    ).counts.tokensIn,
  ).toBe(60)
  expect(
    json(
      "anthropic",
      '{"usage":{"input_tokens":100,"output_tokens":5,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}',
    ).counts,
  ).toEqual({ tokensIn: 100, tokensOut: 5, cacheReadTokens: 40, cacheWriteTokens: 10 })
})
test("whole JSON values obey persistence domain without numeric-prefix corruption", () => {
  for (const [raw, value] of [
    ["2147483647", 2147483647],
    ["1e3", 1000],
    ["1.0", 1],
    ["0", 0],
  ] as const) {
    const facts = json("openai-chat", `{"usage":{"prompt_tokens":${raw}}}`)
    expect(facts.usageInvalid).toBe(false)
    expect(facts.counts.tokensIn).toBe(value)
  }
  for (const raw of ["2147483648", "1e20", "1e-3", "1.5", "-1", '"100"', "null"]) {
    const facts = json("openai-chat", `{"usage":{"prompt_tokens":${raw}}}`)
    expect(facts.usageInvalid).toBe(true)
    expect(facts.counts.tokensIn).toBe(0)
  }
})
test("invalid atomic sample preserves previous complete reading; valid sample never mixes independent maxima", () => {
  const observer = createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 4096,
  })
  const sample = (input: number, cache: number, output: number) =>
    observer.observe(
      encoder.encode(
        `data: {"type":"response.completed","response":{"usage":{"input_tokens":${input},"output_tokens":${output},"input_tokens_details":{"cached_tokens":${cache}}}}}\n\n`,
      ),
    )
  sample(100, 80, 5)
  const held = observer.snapshot()
  sample(10, 11, 999)
  expect(observer.snapshot().counts).toEqual(held.counts)
  expect(observer.snapshot().usageInvalid).toBe(true)
  sample(200, 10, 9)
  expect(observer.finish().counts).toEqual({
    tokensIn: 190,
    tokensOut: 9,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
  })
  expect(held.counts.cacheReadTokens).toBe(80)
  expect(Object.isFrozen(held.counts)).toBe(true)
})
test("token-looking content and arbitrary nested usage do not count", () => {
  for (const text of [
    JSON.stringify({ content: '{"usage":{"input_tokens":999}}' }),
    '{"output":[{"usage":{"input_tokens":999}}]}',
    '{"input_tokens":999}',
    '{"usage":{"total_tokens":999}}',
  ]) {
    expect(json("openai-responses", text).counts.tokensIn).toBe(0)
  }
})
test("count-tokens never spends; embeddings need no generation completion marker", () => {
  for (const operation of ["count-tokens", "embeddings"] as const) {
    const observer = createResponseObserver({
      dialect: "openai-chat",
      operation,
      contentType: "application/json",
      maximumObservationBytes: 4096,
      descriptor: { terminalPolicy: "require-completion" },
    })
    observer.observe(encoder.encode('{"usage":{"prompt_tokens":12}}'))
    expect(observer.finish().counts.tokensIn).toBe(operation === "count-tokens" ? 0 : 12)
    expect(observer.finish().failure).toBeNull()
  }
})

test("null usage/details placeholders are absent evidence rather than malformed token counts", () => {
  expect(json("openai-chat", '{"usage":null}').usageInvalid).toBe(false)
  expect(
    json("openai-chat", '{"usage":{"prompt_tokens":100,"prompt_tokens_details":null}}').counts
      .tokensIn,
  ).toBe(100)
})

test("Anthropic input/cache bundle remains atomic while output-only deltas preserve it", () => {
  const observer = createResponseObserver({
    dialect: "anthropic",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 4096,
  })
  const send = (usage: unknown, start = false) =>
    observer.observe(
      encoder.encode(
        `data: ${JSON.stringify(start ? { type: "message_start", message: { usage } } : { type: "message_delta", usage })}\n\n`,
      ),
    )
  send({ input_tokens: 100, cache_read_input_tokens: 80 }, true)
  send({ output_tokens: 7 })
  expect(observer.snapshot().counts).toMatchObject({
    tokensIn: 100,
    cacheReadTokens: 80,
    tokensOut: 7,
  })
  send({ input_tokens: 200 }, true)
  expect(observer.snapshot().counts).toMatchObject({
    tokensIn: 200,
    cacheReadTokens: 0,
    tokensOut: 7,
  })
  send({ cache_read_input_tokens: 90, output_tokens: 999 })
  expect(observer.finish().counts).toMatchObject({
    tokensIn: 200,
    cacheReadTokens: 0,
    tokensOut: 7,
  })
  expect(observer.finish().usageInvalid).toBe(true)
})
