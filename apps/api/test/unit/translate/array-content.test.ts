import { describe, expect, test } from "bun:test"
import {
  openAiChatToAnthropicResponse,
  openAiChatToAnthropicStream,
  openAiChatToOpenAiResponsesResponse,
} from "../../../src/services/translate"
import { ROUTER_THINKING_SIGNATURE } from "../../../src/services/translate/shared/router-thinking"
import { openAiChatChunk, payloads } from "./fixtures"

/**
 * developerz.ai plan 101 slice 09, finding R11: Mistral's reasoning models (magistral) answer with
 * `content` as an array of chunks — `{type:"thinking", thinking:[{type:"text",text}]}` beside
 * `{type:"text",text}` — and it turns polymorphic mid-stream. Every openai-chat reader typed
 * `content` as a string, so the array read as absent and **the answer text was dropped**, not only
 * the thinking. The shared wire schema now folds the array: text chunks into `content`, thinking
 * chunks into the reasoning text (when the upstream stated none under its own name).
 */

const THINKING = { type: "thinking", thinking: [{ type: "text", text: "the user wants a number" }] }

function completion(message: Record<string, unknown>): unknown {
  return {
    id: "chatcmpl-1",
    model: "magistral-medium-latest",
    choices: [{ index: 0, message, finish_reason: "stop" }],
  }
}

describe("openai-chat array content (Mistral)", () => {
  test("a non-streamed array answer keeps its text and its thinking toward anthropic", () => {
    const out = openAiChatToAnthropicResponse(
      completion({ role: "assistant", content: [THINKING, { type: "text", text: "42" }] }),
    )
    expect((out.body as { content: unknown[] }).content).toEqual([
      {
        type: "thinking",
        thinking: "the user wants a number",
        signature: ROUTER_THINKING_SIGNATURE,
      },
      { type: "text", text: "42" },
    ])
  })

  test("a non-streamed array answer keeps its text toward openai-responses", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      completion({ role: "assistant", content: [THINKING, { type: "text", text: "42" }] }),
      { created: 1_700_000_000 },
    )
    expect(JSON.stringify(out.body)).toContain('"text":"42"')
  })

  test("a streamed array delta carries its thinking, then its text", () => {
    const stream = openAiChatToAnthropicStream({ id: "fallback" })
    const events = [
      ...stream.push(openAiChatChunk({ content: [THINKING] })),
      ...stream.push(openAiChatChunk({ content: [{ type: "text", text: "4" }] })),
      ...stream.push(openAiChatChunk({ content: "2" })),
    ]
    const deltas = payloads(events)
      .filter((event) => (event as { type: string }).type === "content_block_delta")
      .map((event) => (event as { delta: Record<string, unknown> }).delta)
      .filter((delta) => delta.type !== "signature_delta")
    expect(deltas).toEqual([
      { type: "thinking_delta", thinking: "the user wants a number" },
      { type: "text_delta", text: "4" },
      { type: "text_delta", text: "2" },
    ])
  })

  test("a reasoning field the upstream named wins over thinking chunks: never doubled", () => {
    const out = openAiChatToAnthropicResponse(
      completion({
        role: "assistant",
        reasoning_content: "named",
        content: [THINKING, { type: "text", text: "42" }],
      }),
    )
    const blocks = (out.body as { content: { type: string; thinking?: string }[] }).content
    expect(blocks.filter((block) => block.type === "thinking").map((b) => b.thinking)).toEqual([
      "named",
    ])
  })

  test("an array with no text chunk is no answer text, and unknown chunk types are ignored", () => {
    const out = openAiChatToAnthropicResponse(
      completion({ role: "assistant", content: [THINKING, { type: "reference", ids: [1] }] }),
    )
    const blocks = (out.body as { content: { type: string }[] }).content
    expect(blocks.map((block) => block.type)).toEqual(["thinking"])
  })
})
