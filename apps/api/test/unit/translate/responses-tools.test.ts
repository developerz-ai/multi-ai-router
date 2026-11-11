/**
 * Responses tool declarations off the Responses dialect (06.9, 06.14).
 *
 * A hosted built-in (`web_search`) is dropped and reported, as an Anthropic server tool already is:
 * a Codex-style client ships its whole toolkit every turn, and a `400` over a tool nobody on the
 * other side runs served nothing. A client-executed `custom` tool keeps its `400`, named for what
 * it is. `strict` survives between the two OpenAI dialects, which both state it.
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import {
  dropSignature,
  openAiChatToOpenAiResponsesRequest,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToOpenAiChatRequest,
  type TranslationDrop,
} from "../../../src/services/translate"

const fn = { type: "function", name: "f", parameters: { type: "object" } }

function toChat(extra: Record<string, unknown>) {
  const drops: TranslationDrop[] = []
  const out = openAiResponsesToOpenAiChatRequest(
    { model: "m", input: "hi", ...extra },
    { onDrop: (drop) => drops.push(drop) },
  )
  return { out, drops }
}

describe("hosted built-ins are dropped and reported", () => {
  test("function + web_search → one tool emitted, one drop reported", () => {
    const { out, drops } = toChat({ tools: [fn, { type: "web_search" }] })
    expect(out.tools?.map((tool) => tool.function.name)).toEqual(["f"])
    expect(drops).toEqual([{ field: "tools[1]", reason: expect.stringContaining("web_search") }])
  })

  test("toward anthropic too", () => {
    const drops: TranslationDrop[] = []
    const out = openAiResponsesToAnthropicRequest(
      { model: "m", input: "hi", tools: [fn, { type: "file_search" }] },
      { onDrop: (drop) => drops.push(drop) },
    )
    expect(out.tools?.map((tool) => tool.name)).toEqual(["f"])
    expect(drops.map((drop) => drop.field)).toEqual(["tools[1]"])
  })

  test("a choice forcing a dropped built-in goes with it", () => {
    const { out, drops } = toChat({
      tools: [fn, { type: "web_search_preview" }],
      tool_choice: { type: "web_search_preview" },
    })
    expect(out.tool_choice).toBeUndefined()
    expect(drops.map((drop) => drop.field)).toEqual(["tools[1]", "tool_choice"])
  })

  test("only built-ins: no tools, no `required`, no parallel policy reach the upstream", () => {
    const { out, drops } = toChat({
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      parallel_tool_calls: false,
    })
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
    expect(out.parallel_tool_calls).toBeUndefined()
    expect(drops.map((drop) => drop.field)).toEqual(["tools[0]", "tool_choice"])
  })
})

describe("client-executed tools keep their 400", () => {
  test("`custom` is refused, named as a client-executed tool", () => {
    expect(() => toChat({ tools: [fn, { type: "custom", name: "apply_patch" }] })).toThrow(
      /tools\[1\].*client-executed/,
    )
    expect(() => toChat({ tools: [fn, { type: "custom", name: "apply_patch" }] })).toThrow(
      TranslationError,
    )
  })

  test("a choice naming a client-executed built-in is refused", () => {
    expect(() => toChat({ tools: [fn], tool_choice: { type: "local_shell" } })).toThrow(
      /tool_choice\.type/,
    )
  })
})

describe("`strict` between the OpenAI dialects", () => {
  test("responses → chat carries it", () => {
    const { out } = toChat({ tools: [{ ...fn, strict: true }] })
    expect(out.tools?.[0]?.function.strict).toBe(true)
  })

  test("chat → responses carries it, and absent stays absent", () => {
    const out = openAiChatToOpenAiResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", parameters: { type: "object" }, strict: true } },
        { type: "function", function: { name: "b", parameters: { type: "object" } } },
      ],
    })
    expect(out.tools?.[0]?.strict).toBe(true)
    expect(out.tools?.[1] && "strict" in out.tools[1]).toBe(false)
  })

  test("toward anthropic it is not carried", () => {
    const out = openAiResponsesToAnthropicRequest({
      model: "m",
      input: "hi",
      tools: [{ ...fn, strict: true }],
    })
    expect(out.tools?.[0] && "strict" in out.tools[0]).toBe(false)
  })
})

describe("dropSignature (12.15)", () => {
  test("the same drops in any order give one signature; different drops differ", () => {
    const a = { field: "tools[1]", reason: "x" }
    const b = { field: "tool_choice", reason: "y" }
    expect(dropSignature([a, b])).toBe(dropSignature([b, a]))
    expect(dropSignature([a])).not.toBe(dropSignature([b]))
  })
})
