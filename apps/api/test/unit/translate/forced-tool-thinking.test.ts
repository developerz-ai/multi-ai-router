/**
 * Anthropic `thinking` beside a forced `tool_choice`, translated toward an OpenAI dialect.
 *
 * Prod, 2026-10-16: the Vercel AI SDK (`ai/6.0.188`) sends `/v1/messages` bodies stating
 * `thinking: {type: "enabled", budget_tokens}` and `tool_choice: {type: "tool", name: "json"}`.
 * Translated to openai-chat, the budget became `reasoning_effort` beside `tool_choice` naming the
 * function, and a Qwen account answered `400` "The tool_choice parameter does not support being set
 * to required or object in thinking mode" (~200 in a week). The force is the contract; thinking
 * yields to it, dropped and reported — the model is never touched.
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequest,
  type TranslationDrop,
} from "../../../src/services/translate"
import { anthropicRequest, anthropicTool } from "./fixtures"

const JSON_TOOL = anthropicTool({ name: "json" })

function prodShape(
  toolChoice: unknown,
  thinking: unknown = { type: "enabled", budget_tokens: 8192 },
) {
  return {
    ...anthropicRequest({ model: "qwen3.8-max", tools: [JSON_TOOL], tool_choice: toolChoice }),
    thinking,
  }
}

function toChat(body: unknown): { out: Record<string, unknown>; drops: TranslationDrop[] } {
  const drops: TranslationDrop[] = []
  const out = anthropicToOpenAiChatRequest(body, { onDrop: (d) => drops.push(d) })
  return { out: out as unknown as Record<string, unknown>, drops }
}

function toResponses(body: unknown): { out: Record<string, unknown>; drops: TranslationDrop[] } {
  const drops: TranslationDrop[] = []
  const out = anthropicToOpenAiResponsesRequest(body, { onDrop: (d) => drops.push(d) })
  return { out: out as unknown as Record<string, unknown>, drops }
}

describe("anthropic -> openai-chat: a forced tool wins over thinking", () => {
  test("prod shape: tool_choice {type: tool} + thinking enabled sends no reasoning_effort", () => {
    const { out, drops } = toChat(prodShape({ type: "tool", name: "json" }))
    expect(out.reasoning_effort).toBeUndefined()
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "json" } })
    expect(out.model).toBe("qwen3.8-max")
    expect(drops).toHaveLength(1)
    expect(drops[0]?.field).toBe("thinking")
    expect(JSON.stringify(drops)).not.toContain("8192")
  })

  test("tool_choice {type: any} + thinking enabled: same", () => {
    const { out, drops } = toChat(prodShape({ type: "any" }))
    expect(out.reasoning_effort).toBeUndefined()
    expect(out.tool_choice).toBe("required")
    expect(drops.map((d) => d.field)).toEqual(["thinking"])
  })

  test("adaptive thinking yields the same way", () => {
    const { drops } = toChat(prodShape({ type: "any" }, { type: "adaptive" }))
    expect(drops.map((d) => d.field)).toEqual(["thinking"])
  })

  test("an explicit output_config.effort is not thinking and still travels", () => {
    const body = { ...prodShape({ type: "any" }), output_config: { effort: "high" } }
    const { out } = toChat(body)
    expect(out.reasoning_effort).toBe("high")
  })

  test("auto tool_choice keeps the thinking budget as an effort bucket", () => {
    const { out, drops } = toChat(prodShape({ type: "auto" }))
    expect(out.reasoning_effort).toBe("medium")
    expect(drops).toHaveLength(0)
  })

  test("a forced choice dropped with its tool forces nothing, so thinking travels", () => {
    const body = {
      ...anthropicRequest({
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        tool_choice: { type: "tool", name: "web_search" },
      }),
      thinking: { type: "enabled", budget_tokens: 2000 },
    }
    const { out, drops } = toChat(body)
    expect(out.tool_choice).toBeUndefined()
    expect(out.reasoning_effort).toBe("low")
    expect(drops.map((d) => d.field)).not.toContain("thinking")
  })

  test("thinking disabled beside a forced tool is no conflict and reports nothing", () => {
    const { drops } = toChat(prodShape({ type: "any" }, { type: "disabled" }))
    expect(drops).toHaveLength(0)
  })
})

describe("anthropic -> openai-responses: unchanged", () => {
  // OpenAI's Responses surface (and Codex) serves a forced function beside reasoning, and
  // `openai-tools.test.ts` drives that shape end to end, so this hop keeps the dial.
  test("thinking beside a forced function still asks for reasoning", () => {
    const { out, drops } = toResponses(prodShape({ type: "tool", name: "json" }))
    expect(out.reasoning).toEqual({ effort: "medium", summary: "auto" })
    expect(drops).toHaveLength(0)
  })
})
