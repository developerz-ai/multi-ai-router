/**
 * Reasoning across the Anthropic seam (docs/idea/06-protocol-translation.md#known-lossy-edges):
 *
 * - **the effort dial** — OpenAI's `reasoning_effort` / `reasoning.effort` and Anthropic's
 *   `output_config.effort` share one vocabulary, so the word is carried both ways and only clamped
 *   where the target has no such word (`minimal` → `low`, `none` → thinking disabled);
 * - **a thinking budget** with no effort beside it lands in a coarse effort bucket toward OpenAI;
 * - **encrypted reasoning input** is account-bound opaque state another dialect cannot read: it is
 *   dropped and reported by field name, never refused;
 * - **a Responses reasoning summary** becomes an Anthropic `thinking` block, signed with a
 *   router-tagged marker that is not a secret.
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequest,
  openAiChatToAnthropicRequest,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToAnthropicResponse,
  openAiResponsesToAnthropicStream,
  openAiResponsesToOpenAiChatRequest,
  type TranslationDrop,
} from "../../../src/services/translate"
import { ROUTER_THINKING_SIGNATURE } from "../../../src/services/translate/shared/router-thinking"
import {
  anthropicRequest,
  openAiChatRequest,
  openAiResponsesRequest,
  payloads,
  responsesBodyWire,
  responsesFrame,
  responsesTextItem,
} from "./fixtures"

function anthropicWith(fields: Record<string, unknown>): unknown {
  return { ...anthropicRequest(), ...fields }
}

describe("OpenAI effort -> anthropic output_config.effort", () => {
  test("a shared word travels verbatim from either OpenAI dialect", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const fromChat = openAiChatToAnthropicRequest(openAiChatRequest({ reasoning_effort: effort }))
      const fromResponses = openAiResponsesToAnthropicRequest(
        openAiResponsesRequest({ reasoning: { effort } }),
      )
      for (const body of [fromChat, fromResponses]) {
        expect(body.output_config).toEqual({ effort })
        expect(body.thinking).toBeUndefined()
      }
    }
  })

  test("minimal clamps to low: the nearest word anthropic states", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ reasoning_effort: "minimal" }))
    expect(out.output_config).toEqual({ effort: "low" })
  })

  test("none disables thinking rather than naming an effort", () => {
    const out = openAiResponsesToAnthropicRequest(
      openAiResponsesRequest({ reasoning: { effort: "none" } }),
    )
    expect(out.thinking).toEqual({ type: "disabled" })
    expect(out.output_config).toBeUndefined()
  })

  test("a word anthropic has no counterpart for is dropped and reported by field", () => {
    const drops: TranslationDrop[] = []
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({ reasoning_effort: "ultra-thorough" }),
      { onDrop: (drop) => drops.push(drop) },
    )
    expect(out.output_config).toBeUndefined()
    expect(drops.map((drop) => drop.field)).toEqual(["reasoning_effort"])
    expect(JSON.stringify(drops)).not.toContain("ultra-thorough")
  })

  test("no effort stated, nothing emitted", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest())
    expect(out.output_config).toBeUndefined()
    expect(out.thinking).toBeUndefined()
  })
})

describe("anthropic output_config.effort / thinking -> OpenAI effort", () => {
  test("output_config.effort becomes reasoning_effort and reasoning.effort", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const body = anthropicWith({ output_config: { effort } })
      expect(anthropicToOpenAiChatRequest(body).reasoning_effort).toBe(effort)
      expect(anthropicToOpenAiResponsesRequest(body).reasoning).toEqual({
        effort,
        summary: "auto",
      })
    }
  })

  test("an explicit effort wins over a thinking budget", () => {
    const body = anthropicWith({
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "high" },
    })
    expect(anthropicToOpenAiChatRequest(body).reasoning_effort).toBe("high")
  })

  test("a thinking budget with no effort lands in a bucket", () => {
    const cases: [number, string][] = [
      [1024, "low"],
      [4000, "low"],
      [10_000, "medium"],
      [31_999, "high"],
      [64_000, "high"],
    ]
    for (const [budget, effort] of cases) {
      const body = anthropicWith({ thinking: { type: "enabled", budget_tokens: budget } })
      expect(anthropicToOpenAiChatRequest(body).reasoning_effort).toBe(effort)
      expect(anthropicToOpenAiResponsesRequest(body).reasoning?.effort).toBe(effort)
    }
  })

  test("adaptive thinking asks Responses for a summary without inventing an effort", () => {
    const body = anthropicWith({ thinking: { type: "adaptive" } })
    expect(anthropicToOpenAiResponsesRequest(body).reasoning).toEqual({ summary: "auto" })
    expect(anthropicToOpenAiChatRequest(body).reasoning_effort).toBeUndefined()
  })

  test("no thinking and no effort: no reasoning field at all", () => {
    expect(anthropicToOpenAiResponsesRequest(anthropicRequest()).reasoning).toBeUndefined()
    expect(anthropicToOpenAiChatRequest(anthropicRequest()).reasoning_effort).toBeUndefined()
    const disabled = anthropicWith({ thinking: { type: "disabled" } })
    expect(anthropicToOpenAiResponsesRequest(disabled).reasoning).toBeUndefined()
  })

  test("a malformed thinking or output_config is ignored, never a 400", () => {
    const body = anthropicWith({ thinking: "yes please", output_config: { effort: 7 } })
    expect(anthropicToOpenAiChatRequest(body).reasoning_effort).toBeUndefined()
  })
})

describe("encrypted reasoning input is dropped and reported, not refused", () => {
  const encrypted = { type: "reasoning", summary: [], encrypted_content: "gAAAA-opaque" }
  const translators = [
    ["anthropic", openAiResponsesToAnthropicRequest],
    ["openai-chat", openAiResponsesToOpenAiChatRequest],
  ] as const

  for (const [name, translate] of translators) {
    test(`toward ${name}`, () => {
      const drops: TranslationDrop[] = []
      const out = translate(
        openAiResponsesRequest({
          input: [{ role: "user", content: "hi" }, encrypted, { role: "user", content: "again" }],
          include: ["reasoning.encrypted_content"],
        }),
        { onDrop: (drop) => drops.push(drop) },
      )
      expect(JSON.stringify(out)).not.toContain("gAAAA-opaque")
      expect(drops.map((drop) => drop.field)).toEqual(["include", "input[1].encrypted_content"])
      expect(JSON.stringify(drops)).not.toContain("gAAAA-opaque")
    })

    test(`toward ${name}: any other include entry is still refused`, () => {
      expect(() =>
        translate(openAiResponsesRequest({ include: ["file_search_call.results"] })),
      ).toThrow()
    })

    test(`toward ${name}: item_reference is still refused`, () => {
      expect(() =>
        translate(openAiResponsesRequest({ input: [{ type: "item_reference", id: "x" }] })),
      ).toThrow()
    })
  }
})

describe("Responses reasoning summary -> anthropic thinking block", () => {
  const reasoningItem = {
    type: "reasoning",
    id: "rs_1",
    summary: [
      { type: "summary_text", text: "first" },
      { type: "summary_text", text: "second" },
    ],
    encrypted_content: "gAAAA-opaque",
  }

  test("non-streaming: a thinking block precedes the answer, router-signed", () => {
    const out = openAiResponsesToAnthropicResponse(
      responsesBodyWire({ output: [reasoningItem, responsesTextItem("42")] }),
    )
    const body = out.body as { content: Record<string, unknown>[] }
    expect(body.content).toEqual([
      { type: "thinking", thinking: "first\nsecond", signature: ROUTER_THINKING_SIGNATURE },
      { type: "text", text: "42" },
    ])
    expect(JSON.stringify(body)).not.toContain("gAAAA-opaque")
  })

  test("the router signature is a bare tag carrying nothing", () => {
    expect(ROUTER_THINKING_SIGNATURE).toBe("mar1:")
  })

  test("streaming: summary deltas open a thinking block, signed and closed before the text", () => {
    const stream = openAiResponsesToAnthropicStream({ id: "fallback", model: "gpt-5" })
    const frames = [
      responsesFrame("response.created", { response: { id: "resp_1", model: "gpt-5" } }),
      responsesFrame("response.output_item.added", {
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      }),
      responsesFrame("response.reasoning_summary_text.delta", {
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "fir",
      }),
      responsesFrame("response.reasoning_summary_text.delta", {
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "st",
      }),
      responsesFrame("response.reasoning_summary_text.delta", {
        item_id: "rs_1",
        output_index: 0,
        summary_index: 1,
        delta: "second",
      }),
      responsesFrame("response.output_item.done", {
        output_index: 0,
        item: { type: "reasoning", id: "rs_1" },
      }),
      responsesFrame("response.output_text.delta", {
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        delta: "42",
      }),
      responsesFrame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [] },
      }),
    ]
    const events = frames.flatMap((frame) => stream.push(frame))
    const data = payloads(events) as {
      type: string
      index?: number
      content_block?: Record<string, unknown>
      delta?: Record<string, unknown>
    }[]
    const types = data.map((event) => event.type)
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(data[1]?.content_block).toEqual({ type: "thinking", thinking: "", signature: "" })
    const thinking = data
      .filter((event) => event.delta?.type === "thinking_delta")
      .map((event) => event.delta?.thinking)
      .join("")
    expect(thinking).toBe("first\nsecond")
    expect(data[5]?.delta).toEqual({
      type: "signature_delta",
      signature: ROUTER_THINKING_SIGNATURE,
    })
    expect(data[7]?.content_block).toEqual({ type: "text", text: "" })
    expect(data[7]?.index).toBe(1)
  })
})

describe("router-signed thinking never travels onward", () => {
  test("anthropic -> OpenAI dialects drop a mar1 thinking block from the transcript", () => {
    const body = anthropicWith({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "router-made", signature: ROUTER_THINKING_SIGNATURE },
            { type: "text", text: "a" },
          ],
        },
        { role: "user", content: "q2" },
      ],
    })
    expect(JSON.stringify(anthropicToOpenAiChatRequest(body))).not.toContain("router-made")
    expect(JSON.stringify(anthropicToOpenAiResponsesRequest(body))).not.toContain("router-made")
  })
})
