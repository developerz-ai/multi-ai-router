/**
 * Tool declarations, tool_choice, and call-argument conversion
 * (docs/idea/06-protocol-translation.md#tool-and-function-calling).
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import {
  argumentsFromInput,
  inputFromArguments,
  toolChoiceToAnthropic,
  toolChoiceToOpenAiChat,
  toolsToAnthropic,
  toolsToOpenAiChat,
} from "../../../src/services/translate"
import { anthropicTool, openAiChatTool } from "./fixtures"

describe("tool declarations: anthropic -> openai-chat", () => {
  test("maps name, description, input_schema onto function.{name,description,parameters}", () => {
    const [out] = toolsToOpenAiChat([anthropicTool()])
    expect(out).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Look up the weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    })
  })

  test("a tool with no input_schema (a server-side tool) is rejected by name", () => {
    expect(() => toolsToOpenAiChat([{ type: "web_search", name: "web_search" } as never])).toThrow(
      /web_search/,
    )
  })

  test("a non-object input_schema type is rejected", () => {
    expect(() =>
      toolsToOpenAiChat([anthropicTool({ input_schema: { type: "array" } }) as never]),
    ).toThrow(TranslationError)
  })

  test("a missing name is rejected", () => {
    expect(() => toolsToOpenAiChat([anthropicTool({ name: undefined }) as never])).toThrow(
      TranslationError,
    )
  })
})

describe("tool declarations: openai-chat -> anthropic", () => {
  test("maps function.{name,description,parameters} onto {name,description,input_schema}", () => {
    const [out] = toolsToAnthropic([openAiChatTool()])
    expect(out).toEqual({
      name: "get_weather",
      description: "Look up the weather for a city",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    })
  })

  test("a missing parameters object still declares an empty object schema", () => {
    const [out] = toolsToAnthropic([{ type: "function", function: { name: "no_args" } } as never])
    expect(out?.input_schema).toEqual({ type: "object", properties: {} })
  })

  test("an implicit object type is filled in", () => {
    const [out] = toolsToAnthropic([
      openAiChatTool({ function: { name: "n", parameters: { properties: {} } } }) as never,
    ])
    expect(out?.input_schema).toEqual({ properties: {}, type: "object" })
  })

  test("a tool with no function (e.g. a builtin) is rejected by name", () => {
    expect(() => toolsToAnthropic([{ type: "code_interpreter" } as never])).toThrow(
      /code_interpreter/,
    )
  })

  test("`strict` is dropped: no anthropic equivalent, and it is not carried into input_schema", () => {
    const [out] = toolsToAnthropic([openAiChatTool({ strict: true }) as never])
    expect(out).not.toHaveProperty("strict")
  })
})

describe("tool_choice", () => {
  test("anthropic -> openai-chat: auto/any/none/tool map one-to-one", () => {
    expect(toolChoiceToOpenAiChat({ type: "auto" })).toBe("auto")
    expect(toolChoiceToOpenAiChat({ type: "any" })).toBe("required")
    expect(toolChoiceToOpenAiChat({ type: "none" })).toBe("none")
    expect(toolChoiceToOpenAiChat({ type: "tool", name: "get_weather" })).toEqual({
      type: "function",
      function: { name: "get_weather" },
    })
  })

  test("openai-chat -> anthropic: auto/required/none/function map back", () => {
    expect(toolChoiceToAnthropic("auto")).toEqual({ type: "auto" })
    expect(toolChoiceToAnthropic("required")).toEqual({ type: "any" })
    expect(toolChoiceToAnthropic("none")).toEqual({ type: "none" })
    expect(toolChoiceToAnthropic({ type: "function", function: { name: "get_weather" } })).toEqual({
      type: "tool",
      name: "get_weather",
    })
  })
})

describe("call arguments: object <-> JSON string", () => {
  test("argumentsFromInput serializes an object, and never fails", () => {
    expect(argumentsFromInput({ city: "sf" })).toBe('{"city":"sf"}')
    expect(argumentsFromInput({})).toBe("{}")
  })

  test("inputFromArguments parses a JSON string back to an object", () => {
    expect(inputFromArguments('{"city":"sf"}', "field")).toEqual({ city: "sf" })
  })

  test("an absent or blank arguments string is a no-argument call: {}", () => {
    expect(inputFromArguments(undefined, "field")).toEqual({})
    expect(inputFromArguments("", "field")).toEqual({})
    expect(inputFromArguments("   ", "field")).toEqual({})
  })

  test("invalid JSON is a 400 naming the field, never an empty call handed upstream", () => {
    expect(() => inputFromArguments("not json", "tools[0].function.arguments")).toThrow(
      /tools\[0\]\.function\.arguments/,
    )
  })

  test("a JSON array decodes but is rejected: tool_use.input has no array form", () => {
    expect(() => inputFromArguments("[1,2,3]", "field")).toThrow(TranslationError)
  })

  test("a JSON scalar decodes but is rejected: tool_use.input has no scalar form", () => {
    expect(() => inputFromArguments("42", "field")).toThrow(TranslationError)
  })
})
