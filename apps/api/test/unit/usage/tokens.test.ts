import { describe, expect, test } from "bun:test"
import { createTokenObserver } from "../../../src/services/usage"

/**
 * Token counts are read off the stream as it passes. The record stores the **upstream's own**
 * numbers, and the three input fields are kept apart: prompt size is `tokensIn` plus both cache
 * fields, and reporting `tokensIn` alone under-reports cached traffic badly.
 */

const encoder = new TextEncoder()

function observe(...chunks: readonly string[]) {
  const observer = createTokenObserver()
  for (const chunk of chunks) observer.observe(encoder.encode(chunk))
  return observer.counts()
}

describe("token observer", () => {
  test("reads an Anthropic stream: input on message_start, output on message_delta", () => {
    const counts = observe(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":300,"cache_creation_input_tokens":40}}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":19}}\n\n',
    )

    expect(counts).toEqual({
      tokensIn: 12,
      tokensOut: 19,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
    })
  })

  test("reads a non-streamed Anthropic body the same way", () => {
    const counts = observe('{"usage":{"input_tokens":5,"output_tokens":9}}')
    expect(counts).toMatchObject({ tokensIn: 5, tokensOut: 9 })
  })

  test("subtracts OpenAI's cached tokens, which prompt_tokens already includes", () => {
    const counts = observe(
      '{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}',
    )

    expect(counts).toEqual({
      tokensIn: 20,
      tokensOut: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    })
  })

  test("survives a field split across a chunk boundary", () => {
    const counts = observe('{"usage":{"output_tok', 'ens":42,"input_tokens":3}}')
    expect(counts).toMatchObject({ tokensIn: 3, tokensOut: 42 })
  })

  test("reports zeros when the upstream said nothing", () => {
    expect(observe('data: {"type":"ping"}\n\n')).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  test("ignores fields it has no column for rather than guessing one", () => {
    const counts = observe('{"usage":{"total_tokens":999,"reasoning_tokens":50}}')
    expect(counts.tokensIn).toBe(0)
    expect(counts.tokensOut).toBe(0)
  })
})
