import { describe, expect, test } from "bun:test"
import { CODEX_RESPONSES_EGRESS } from "../../../src/providers"
import {
  openAiChatToOpenAiResponsesRequest,
  type TranslationContext,
  translationPair,
} from "../../../src/services/translate"
import { openAiChatRequest } from "./fixtures"

/**
 * Production, 2026-10-16: a caller's `prompt_cache_key` on `/v1/chat/completions` never reached a
 * Codex account. The chat→Responses translator rebuilds the body field by field and had no slot for
 * it, so the upstream saw every step of one conversation as unrelated — 16–22% cache-read share
 * against 98.5% for the same turns via OpenRouter. The first-party Codex CLI sends the field on
 * every Responses request (openai/codex `codex-api/src/common.rs` `ResponsesApiRequest`).
 */

function context(overrides: Partial<TranslationContext> = {}): TranslationContext {
  return { created: 1, model: "gpt-5.5", fallbackId: "req-1", ...overrides }
}

describe("openai-chat → openai-responses: prompt_cache_key", () => {
  test("a caller's prompt_cache_key is carried verbatim", () => {
    const out = openAiChatToOpenAiResponsesRequest({
      ...openAiChatRequest(),
      prompt_cache_key: "conv-0193f2",
    })
    expect(out.prompt_cache_key).toBe("conv-0193f2")
  })

  test("without one, the field is absent — the router never invents a key", () => {
    const out = openAiChatToOpenAiResponsesRequest(openAiChatRequest())
    expect("prompt_cache_key" in JSON.parse(JSON.stringify(out))).toBe(false)
  })

  test("null and empty string state no key", () => {
    for (const value of [null, ""]) {
      const out = openAiChatToOpenAiResponsesRequest({
        ...openAiChatRequest(),
        prompt_cache_key: value,
      })
      expect(out.prompt_cache_key).toBeUndefined()
    }
  })

  test("the Codex surface rules keep it: the backend's own client sends it", () => {
    const pair = translationPair("openai-chat", "openai-responses")
    if (pair === null) throw new Error("no pair")
    const out = pair.request(
      { ...openAiChatRequest({ model: "gpt-5.5" }), prompt_cache_key: "conv-0193f2" },
      context({ responsesEgress: CODEX_RESPONSES_EGRESS }),
    ) as Record<string, unknown>
    expect(out.prompt_cache_key).toBe("conv-0193f2")
  })
})
