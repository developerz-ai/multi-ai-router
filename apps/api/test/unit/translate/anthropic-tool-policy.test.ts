/**
 * The one tool policy both OpenAI dialects get toward Anthropic (06.3, 06.8).
 *
 * `none` states no parallel policy in Anthropic's dialect, so `disable_parallel_tool_use` beside it
 * is a body the router wrote for a strict validator to refuse. A forced choice disables thinking
 * whichever OpenAI dialect asked for it: a think-by-default vendor otherwise ignores the force.
 */

import { describe, expect, test } from "bun:test"
import {
  openAiChatToAnthropicRequest,
  openAiResponsesToAnthropicRequest,
} from "../../../src/services/translate"

const chatTool = { type: "function", function: { name: "f", parameters: { type: "object" } } }
const responsesTool = { type: "function", name: "f", parameters: { type: "object" } }

function chat(extra: Record<string, unknown>) {
  return openAiChatToAnthropicRequest({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [chatTool],
    ...extra,
  })
}

function responses(extra: Record<string, unknown>) {
  return openAiResponsesToAnthropicRequest({
    model: "m",
    input: "hi",
    tools: [responsesTool],
    ...extra,
  })
}

describe("tool_choice none + parallel_tool_calls", () => {
  test("chat ingress: `none` travels bare", () => {
    const out = chat({ tool_choice: "none", parallel_tool_calls: false })
    expect(out.tool_choice).toEqual({ type: "none" })
  })

  test("responses ingress: `none` travels bare", () => {
    const out = responses({ tool_choice: "none", parallel_tool_calls: false })
    expect(out.tool_choice).toEqual({ type: "none" })
  })

  test("auto and absent still carry the parallel policy", () => {
    expect(chat({ tool_choice: "auto", parallel_tool_calls: false }).tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    })
    expect(responses({ parallel_tool_calls: true }).tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: false,
    })
  })
})

describe("a forced choice disables thinking from either ingress", () => {
  test("responses ingress, `required` beside effort high", () => {
    const out = responses({ tool_choice: "required", reasoning: { effort: "high" } })
    expect(out.tool_choice).toEqual({ type: "any" })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("responses ingress, a named function", () => {
    const out = responses({ tool_choice: { type: "function", name: "f" } })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("both ingress dialects produce the same policy for the same intent", () => {
    const fromChat = chat({
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning_effort: "high",
    })
    const fromResponses = responses({
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
    })
    expect(fromResponses.tool_choice).toEqual(fromChat.tool_choice)
    expect(fromResponses.thinking).toEqual(fromChat.thinking)
    expect(fromChat.thinking).toEqual({ type: "disabled" })
  })

  test("auto forces nothing and leaves thinking alone", () => {
    expect(responses({ tool_choice: "auto" }).thinking).toBeUndefined()
  })
})
