/**
 * openai-chat → anthropic: `tool_choice` forcing and `response_format` as a forced tool call
 * (`shared/structured-output-anthropic.ts`).
 *
 * Prod fingerprint, 2026-10-15, MiniMax-M3 behind the Anthropic dialect: `tool_choice: "required"`
 * answered in prose with `finish_reason: "stop"` (the upstream ignores a forced tool while thinking
 * is on), and `response_format: json_schema` was refused 400.
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import type { SseEvent, SseFrame } from "../../../src/services/translate/index"
import {
  anthropicToOpenAiChatResponse,
  anthropicToOpenAiChatStream,
  openAiChatToAnthropicRequest,
} from "../../../src/services/translate/index"
import { STRUCTURED_OUTPUT_TOOL } from "../../../src/services/translate/shared/structured-output-anthropic"
import { anthropicFrame, openAiChatRequest, openAiChatTool, payloads } from "./fixtures"

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "boolean" } },
  required: ["answer"],
}
const JSON_SCHEMA = {
  type: "json_schema",
  json_schema: { name: "result", schema: SCHEMA, strict: true },
}

function refusal(body: Record<string, unknown>): string {
  try {
    openAiChatToAnthropicRequest(openAiChatRequest(body))
  } catch (error) {
    expect(error).toBeInstanceOf(TranslationError)
    return (error as Error).message
  }
  throw new Error("expected a TranslationError")
}

describe("tool_choice is forced, and a forced choice disables thinking", () => {
  test('"required" becomes {type: "any"} with thinking disabled', () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({ tools: [openAiChatTool()], tool_choice: "required" }),
    )
    expect(out.tool_choice).toEqual({ type: "any" })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("a named function becomes {type: tool, name} with thinking disabled", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        tools: [openAiChatTool()],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      }),
    )
    expect(out.tool_choice).toEqual({ type: "tool", name: "get_weather" })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("forced choice beats reasoning_effort for thinking, and keeps the effort word", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        tools: [openAiChatTool()],
        tool_choice: "required",
        reasoning_effort: "high",
      }),
    )
    expect(out.thinking).toEqual({ type: "disabled" })
    expect(out.output_config).toEqual({ effort: "high" })
  })

  test("a forced choice with parallel_tool_calls keeps the parallel policy", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        tools: [openAiChatTool()],
        tool_choice: "required",
        parallel_tool_calls: false,
      }),
    )
    expect(out.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("auto, none and no choice leave thinking untouched", () => {
    for (const tool_choice of ["auto", "none", undefined]) {
      const out = openAiChatToAnthropicRequest(
        openAiChatRequest({ tools: [openAiChatTool()], tool_choice }),
      )
      expect(out.thinking).toBeUndefined()
    }
  })
})

describe("response_format becomes a forced tool call", () => {
  test("json_schema: one tool whose input_schema is the schema, forced, thinking disabled", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ response_format: JSON_SCHEMA }))
    expect(out.tools).toEqual([
      { name: STRUCTURED_OUTPUT_TOOL, description: expect.any(String), input_schema: SCHEMA },
    ])
    expect(out.tool_choice).toEqual({ type: "tool", name: STRUCTURED_OUTPUT_TOOL })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("the schema's description travels as the tool description", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        response_format: {
          type: "json_schema",
          json_schema: { name: "r", schema: SCHEMA, description: "the verdict" },
        },
      }),
    )
    expect(out.tools?.[0]?.description).toBe("the verdict")
  })

  test("json_object: a schema-free object tool, forced", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({ response_format: { type: "json_object" } }),
    )
    expect(out.tools?.[0]?.input_schema).toEqual({ type: "object" })
    expect(out.tool_choice).toEqual({ type: "tool", name: STRUCTURED_OUTPUT_TOOL })
    expect(out.thinking).toEqual({ type: "disabled" })
  })

  test("text and absent constrain nothing", () => {
    for (const response_format of [{ type: "text" }, null, undefined]) {
      const out = openAiChatToAnthropicRequest(openAiChatRequest({ response_format }))
      expect(out.tools).toBeUndefined()
      expect(out.tool_choice).toBeUndefined()
      expect(out.thinking).toBeUndefined()
    }
  })

  test("json_schema beside the caller's tools is refused naming tools", () => {
    const message = refusal({ response_format: JSON_SCHEMA, tools: [openAiChatTool()] })
    expect(message).toContain("`tools`")
    expect(message).toContain("response_format")
  })

  test("json_object beside the caller's tools is refused too", () => {
    const message = refusal({
      response_format: { type: "json_object" },
      tools: [openAiChatTool()],
    })
    expect(message).toContain("`tools`")
  })

  test("an empty tools list beside response_format is not the caller's tools", () => {
    expect(() =>
      openAiChatToAnthropicRequest(openAiChatRequest({ response_format: JSON_SCHEMA, tools: [] })),
    ).not.toThrow()
  })

  test("an unknown response_format type is refused by name, never quoted", () => {
    const message = refusal({ response_format: { type: "grammar_secret" } })
    expect(message).toContain("response_format.type")
    expect(message).not.toContain("grammar_secret")
  })

  test("json_schema without a json_schema object, without a schema, with a non-object root", () => {
    expect(refusal({ response_format: { type: "json_schema" } })).toContain(
      "response_format.json_schema",
    )
    expect(
      refusal({ response_format: { type: "json_schema", json_schema: { name: "secret_shape" } } }),
    ).toContain("response_format.json_schema.schema")
    const root = refusal({
      response_format: {
        type: "json_schema",
        json_schema: { name: "x", schema: { type: "array" } },
      },
    })
    expect(root).toContain("response_format.json_schema.schema")
  })

  test("a refusal never quotes the schema the caller sent", () => {
    const message = refusal({
      response_format: {
        type: "json_schema",
        json_schema: { name: "secret_shape", schema: { type: "array", title: "secret_title" } },
      },
      tools: [openAiChatTool()],
    })
    expect(message).not.toContain("secret_shape")
    expect(message).not.toContain("secret_title")
  })

  test("a client tool named like the router's structured-output tool is refused", () => {
    const message = refusal({
      tools: [openAiChatTool({ function: { name: STRUCTURED_OUTPUT_TOOL, parameters: {} } })],
    })
    expect(message).toContain("tools[0].function.name")
  })
})

describe("the forced tool's input comes back as message.content", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    id: "msg_1",
    model: "MiniMax-M3",
    content: [
      { type: "tool_use", id: "toolu_1", name: STRUCTURED_OUTPUT_TOOL, input: { answer: true } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 4 },
    ...extra,
  })
  const convert = (message: unknown) =>
    anthropicToOpenAiChatResponse(message, { created: 1 }).body as {
      choices: { message: Record<string, unknown>; finish_reason: string }[]
    }

  test("content is the input as JSON, finish_reason stop, no tool_calls", () => {
    const choice = convert(body()).choices[0]
    expect(choice?.message.content).toBe('{"answer":true}')
    expect(choice?.message.tool_calls).toBeUndefined()
    expect(choice?.finish_reason).toBe("stop")
  })

  test("prose beside the forced call is dropped so the content stays parseable", () => {
    const message = body({
      content: [
        { type: "text", text: "Sure!" },
        { type: "tool_use", id: "t", name: STRUCTURED_OUTPUT_TOOL, input: { answer: false } },
      ],
    })
    expect(convert(message).choices[0]?.message.content).toBe('{"answer":false}')
  })

  test("a truncated answer keeps finish_reason length", () => {
    expect(convert(body({ stop_reason: "max_tokens" })).choices[0]?.finish_reason).toBe("length")
  })

  test("any other tool_use is still a tool call", () => {
    const message = body({
      content: [{ type: "tool_use", id: "t", name: "get_weather", input: { city: "x" } }],
    })
    const choice = convert(message).choices[0]
    expect(choice?.finish_reason).toBe("tool_calls")
    expect(choice?.message.tool_calls).toHaveLength(1)
  })
})

describe("the forced tool streams as content deltas", () => {
  function run(frames: readonly SseFrame[]): SseEvent[] {
    const stream = anthropicToOpenAiChatStream({ created: 1, id: "x", model: "m" })
    const events: SseEvent[] = []
    for (const frame of frames) events.push(...stream.push(frame))
    events.push(...stream.flush())
    return events
  }
  const frames = (stopReason: string): SseFrame[] => [
    anthropicFrame("message_start", { message: { id: "msg_1", model: "m", usage: {} } }),
    anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "t", name: STRUCTURED_OUTPUT_TOOL, input: {} },
    }),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"ans' },
    }),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'wer":true}' },
    }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("message_delta", { delta: { stop_reason: stopReason }, usage: {} }),
    anthropicFrame("message_stop"),
  ]
  type Chunk = { choices: { delta: Record<string, unknown>; finish_reason: string | null }[] }

  test("content deltas concatenate to the JSON, no tool_calls, finish stop", () => {
    const chunks = payloads(run(frames("tool_use"))) as Chunk[]
    const content = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")
    expect(content).toBe('{"answer":true}')
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.tool_calls !== undefined)).toBe(false)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop")
  })

  test("a truncated stream keeps finish_reason length", () => {
    const chunks = payloads(run(frames("max_tokens"))) as Chunk[]
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("length")
  })

  test("another tool still streams as tool_calls with finish tool_calls", () => {
    const other = frames("tool_use").map((frame) => ({
      ...frame,
      data: frame.data.replace(STRUCTURED_OUTPUT_TOOL, "get_weather"),
    }))
    const chunks = payloads(run(other)) as Chunk[]
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.tool_calls !== undefined)).toBe(true)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls")
  })
})
