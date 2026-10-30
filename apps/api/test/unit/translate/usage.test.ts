/**
 * Token usage ⇄ across the anthropic ⇄ openai-chat seam
 * (docs/idea/06-protocol-translation.md#usage-and-token-fields).
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicUsageCounts,
  parseAnthropicUsage,
  parseOpenAiChatUsage,
  usageToAnthropic,
  usageToOpenAiChat,
} from "../../../src/services/translate"
import { anthropicUsageWire, openAiChatUsageWire } from "./fixtures"

describe("parsing", () => {
  test("parseAnthropicUsage reads the four known fields", () => {
    expect(parseAnthropicUsage(anthropicUsageWire())).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    })
  })

  test("a missing field is null, never zero", () => {
    expect(parseAnthropicUsage({ input_tokens: 100 })).toEqual({
      input_tokens: 100,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
  })

  test("a malformed or absent usage block parses to null, and never throws", () => {
    expect(parseAnthropicUsage(null)).toBeNull()
    expect(parseAnthropicUsage("not an object")).toBeNull()
    expect(parseAnthropicUsage(undefined)).toBeNull()
  })

  test("parseOpenAiChatUsage reads prompt/completion/total plus nested cached_tokens", () => {
    expect(parseOpenAiChatUsage(openAiChatUsageWire())).toEqual({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    })
  })

  test("a one-bad-field usage block still reports the good fields via per-field .catch", () => {
    expect(parseAnthropicUsage({ input_tokens: "not a number", output_tokens: 50 })).toEqual({
      input_tokens: null,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
  })
})

describe("anthropic -> openai-chat: prompt_tokens is a sum, not a rename", () => {
  test("input + cache_creation + cache_read sum into prompt_tokens", () => {
    const out = usageToOpenAiChat({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    })
    expect(out.prompt_tokens).toBe(130)
    expect(out.completion_tokens).toBe(50)
    expect(out.total_tokens).toBe(180)
    expect(out.prompt_tokens_details).toEqual({ cached_tokens: 20 })
  })

  test("cache_read_input_tokens of null omits prompt_tokens_details entirely", () => {
    const out = usageToOpenAiChat({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
    expect(out.prompt_tokens_details).toBeUndefined()
  })

  test("a partial total is still reported when only some terms are known", () => {
    const out = usageToOpenAiChat({
      input_tokens: 100,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
    expect(out.prompt_tokens).toBe(100)
    expect(out.total_tokens).toBe(100)
    expect(out.completion_tokens).toBeNull()
  })

  test("all-null terms sum to null, not zero", () => {
    const out = usageToOpenAiChat({
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
    expect(out.prompt_tokens).toBeNull()
    expect(out.total_tokens).toBeNull()
  })
})

describe("openai-chat -> anthropic: cache_read is subtracted back out", () => {
  test("cached_tokens is subtracted from prompt_tokens to recover input_tokens", () => {
    const out = usageToAnthropic({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    })
    expect(out.input_tokens).toBe(110)
    expect(out.output_tokens).toBe(50)
    expect(out.cache_read_input_tokens).toBe(20)
  })

  test("cache_creation_input_tokens is null when the upstream reports no write", () => {
    const out = usageToAnthropic({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    })
    expect(out.cache_creation_input_tokens).toBeNull()
  })

  test("total_tokens and reasoning_tokens are dropped: anthropic states neither", () => {
    const out = usageToAnthropic({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    })
    expect(out).not.toHaveProperty("total_tokens")
    expect(out).not.toHaveProperty("completion_tokens_details")
  })

  test("more cached tokens than prompt tokens clamps at zero, never negative", () => {
    const out = usageToAnthropic({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 999 },
    })
    expect(out.input_tokens).toBe(0)
  })

  test("a missing prompt_tokens yields a null input_tokens, not zero", () => {
    const out = usageToAnthropic({
      prompt_tokens: null,
      completion_tokens: 50,
      total_tokens: null,
    })
    expect(out.input_tokens).toBeNull()
  })

  test("no cached_tokens detail leaves the subtraction untouched", () => {
    const out = usageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    })
    expect(out.input_tokens).toBe(100)
    expect(out.cache_read_input_tokens).toBeNull()
  })
})

describe("cache writes and cache hits an openai-chat upstream reports", () => {
  test("OpenRouter's prompt_tokens_details.cache_write_tokens maps to cache_creation_input_tokens", () => {
    const parsed = parseOpenAiChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
    })
    expect(parsed).not.toBeNull()
    if (parsed === null) return
    expect(usageToAnthropic(parsed)).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 600,
    })
    expect(anthropicUsageCounts(parsed)).toEqual({
      output_tokens: 5,
      input_tokens: 100,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 300,
    })
  })

  test("DeepSeek's top-level prompt_cache_hit_tokens is a cache read", () => {
    const parsed = parseOpenAiChatUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 64,
      prompt_cache_miss_tokens: 36,
    })
    expect(parsed?.prompt_tokens_details?.cached_tokens).toBe(64)
    expect(parsed === null ? null : usageToAnthropic(parsed).input_tokens).toBe(36)
  })

  test("an unreported write stays absent on the Anthropic wire", () => {
    expect(
      anthropicUsageCounts({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({ output_tokens: 5, input_tokens: 60, cache_read_input_tokens: 40 })
  })
})
