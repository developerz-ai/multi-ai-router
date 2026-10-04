import { expect, test } from "bun:test"
import { anthropicToOpenAiChatResponse } from "../../../src/services/translate/anthropic-to-openai-chat/response"
import { openAiChatToAnthropicResponse } from "../../../src/services/translate/openai-chat-to-anthropic/response"
import { openAiChatToAnthropicStream } from "../../../src/services/translate/openai-chat-to-anthropic/stream"
import { openAiChatToOpenAiResponsesStream } from "../../../src/services/translate/openai-chat-to-openai-responses/stream"
import { createOpenAiChatToolCallReader } from "../../../src/services/translate/shared/openai-chat-tool-calls"
import type { SseEvent, StreamTranslator } from "../../../src/services/translate/sse/emit"

function frame(body: unknown) {
  return { event: null, data: JSON.stringify(body) }
}
function feed(t: StreamTranslator): readonly SseEvent[] {
  const out: SseEvent[] = []
  out.push(
    ...t.push(
      frame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "a", function: { name: "f", arguments: '{"x":' } }] },
            finish_reason: null,
          },
        ],
      }),
    ),
  )
  out.push(...t.push(frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })))
  out.push(
    ...t.push(
      frame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "a", function: { arguments: "1}" } }] },
            finish_reason: null,
          },
        ],
      }),
    ),
  )
  out.push(...t.push({ event: null, data: "[DONE]" }))
  return out
}
test("repeated indexless IDs preserve one call and interleaved identity", () => {
  const r = createOpenAiChatToolCallReader()
  const a = r.key({ id: "a", function: { name: "f" } }),
    b = r.key({ id: "b", function: { name: "g" } })
  expect(b).not.toBe(a)
  expect(r.key({ id: "a", function: { arguments: "1" } })).toBe(a)
  expect(r.key({ function: { arguments: "2" } })).toBe(a)
  const indexed = r.key({ index: 4, id: "indexed" })
  expect(r.key({ id: "indexed", function: { arguments: "3" } })).toBe(indexed)
})
test("actual tool calls infer tool_use without replacing token limit", () => {
  for (const finish of [null, "stop", "length"]) {
    const result = openAiChatToAnthropicResponse({
      choices: [
        {
          index: 0,
          message: { tool_calls: [{ id: "a", function: { name: "f", arguments: "{}" } }] },
          finish_reason: finish,
        },
      ],
    })
    expect(result.body).toMatchObject({
      stop_reason: finish === "length" ? "max_tokens" : "tool_use",
    })
  }
})
test("completed Anthropic null stop gets conservative Chat terminal", () => {
  expect(
    anthropicToOpenAiChatResponse(
      { content: [{ type: "text", text: "hello" }], stop_reason: null },
      { created: 1 },
    ).body,
  ).toMatchObject({ choices: [{ finish_reason: "stop" }] })
})
test("Chat to Anthropic late arguments retain one complete call", () => {
  const events = feed(openAiChatToAnthropicStream())
  const starts = events
    .map((e) => JSON.parse(e.data))
    .filter((e) => e.type === "content_block_start" && e.content_block.type === "tool_use")
  expect(starts).toHaveLength(1)
  expect(
    events
      .map((e) => JSON.parse(e.data))
      .filter((e) => e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json)
      .join(""),
  ).toBe('{"x":1}')
})
test("Chat to Responses late arguments retain one complete call", () => {
  const events = feed(openAiChatToOpenAiResponsesStream({ created: 1 }))
  const payloads = events.map((e) => JSON.parse(e.data))
  expect(
    payloads
      .filter((e) => e.type === "response.function_call_arguments.done")
      .map((e) => e.arguments),
  ).toEqual(['{"x":1}'])
  expect(
    payloads.filter(
      (e) => e.type === "response.output_item.done" && e.item.type === "function_call",
    ),
  ).toHaveLength(1)
})

import { anthropicToOpenAiChatStream } from "../../../src/services/translate/anthropic-to-openai-chat/stream"
import { anthropicToOpenAiResponsesStream } from "../../../src/services/translate/anthropic-to-openai-responses/stream"

function emptyCall(t: StreamTranslator): readonly SseEvent[] {
  return [
    ...t.push(
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "a", name: "f", input: {} },
      }),
    ),
    ...t.push(
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "" },
      }),
    ),
    ...t.push(frame({ type: "content_block_stop", index: 0 })),
    ...t.push(frame({ type: "message_delta", delta: { stop_reason: "tool_use" } })),
    ...t.push(frame({ type: "message_stop" })),
  ]
}
test("Anthropic no-argument tool has valid Chat JSON", () => {
  const payloads = emptyCall(anthropicToOpenAiChatStream({ created: 1 }))
    .filter((e) => e.data !== "[DONE]")
    .map((e) => JSON.parse(e.data))
  expect(
    payloads
      .flatMap((e) => e.choices ?? [])
      .flatMap((e) => e.delta?.tool_calls ?? [])
      .map((e) => e.function?.arguments ?? "")
      .join(""),
  ).toBe("{}")
})
test("Anthropic no-argument tool has valid Responses JSON", () => {
  const payloads = emptyCall(anthropicToOpenAiResponsesStream({ created: 1 })).map((e) =>
    JSON.parse(e.data),
  )
  expect(
    payloads
      .filter((e) => e.type === "response.function_call_arguments.done")
      .map((e) => e.arguments),
  ).toEqual(["{}"])
  expect(
    payloads.filter((e) => e.type === "response.output_item.done").map((e) => e.item.arguments),
  ).toEqual(["{}"])
})

import { anthropicToOpenAiChatRequest } from "../../../src/services/translate/anthropic-to-openai-chat/request"
import { anthropicToOpenAiResponsesRequest } from "../../../src/services/translate/anthropic-to-openai-responses/request"
import { openAiChatToAnthropicRequest } from "../../../src/services/translate/openai-chat-to-anthropic/request"
import { openAiResponsesToAnthropicRequest } from "../../../src/services/translate/openai-responses-to-anthropic/request"

test("Anthropic caller serial tool policy survives both OpenAI dialects", () => {
  const body = {
    model: "m",
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  }
  expect(anthropicToOpenAiChatRequest(body)).toMatchObject({ parallel_tool_calls: false })
  expect(anthropicToOpenAiResponsesRequest(body)).toMatchObject({ parallel_tool_calls: false })
})
test("OpenAI parallel policy does not synthesize Anthropic choice without tools", () => {
  for (const tools of [undefined, []]) {
    for (const parallel_tool_calls of [false, true]) {
      expect(
        openAiChatToAnthropicRequest({
          model: "m",
          messages: [{ role: "user", content: "hello" }],
          tools,
          parallel_tool_calls,
        }).tool_choice,
      ).toBeUndefined()
      expect(
        openAiResponsesToAnthropicRequest({
          model: "m",
          input: "hello",
          tools,
          parallel_tool_calls,
        }).tool_choice,
      ).toBeUndefined()
      expect(
        openAiChatToAnthropicRequest({
          model: "m",
          messages: [{ role: "user", content: "hello" }],
          tools,
          parallel_tool_calls,
          tool_choice: "none",
        }).tool_choice,
      ).toEqual({ type: "none" })
      expect(
        openAiResponsesToAnthropicRequest({
          model: "m",
          input: "hello",
          tools,
          parallel_tool_calls,
          tool_choice: "none",
        }).tool_choice,
      ).toEqual({ type: "none" })
    }
  }
})

test("OpenAI nonempty tools retain both parallel policies and explicit choice", () => {
  for (const parallel_tool_calls of [false, true]) {
    for (const tool_choice of [undefined, "required"] as const) {
      const expected = {
        type: tool_choice === undefined ? "auto" : "any",
        disable_parallel_tool_use: !parallel_tool_calls,
      }
      expect(
        openAiChatToAnthropicRequest({
          model: "m",
          messages: [{ role: "user", content: "hello" }],
          parallel_tool_calls,
          tool_choice,
          tools: [
            { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
          ],
        }).tool_choice,
      ).toEqual(expected)
      expect(
        openAiResponsesToAnthropicRequest({
          model: "m",
          input: "hello",
          parallel_tool_calls,
          tool_choice,
          tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        }).tool_choice,
      ).toEqual(expected)
    }
  }
})

import { createTranslatedRequestBody } from "../../../src/services/dataplane/translate-body"
import { openAiResponsesToOpenAiChatStream } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"
import { translationPair } from "../../../src/services/translate/registry"

test("Chat usage-only frames require explicit caller opt in for both upstream dialects", () => {
  for (const includeUsage of [undefined, false, true]) {
    const anthropic = anthropicToOpenAiChatStream({ created: 1, includeUsage })
    const responses = openAiResponsesToOpenAiChatStream({ created: 1, includeUsage })
    const a = anthropic.push(
      frame({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    )
    const r = responses.push(
      frame({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      }),
    )
    for (const events of [a, r]) {
      const payloads = events.filter((e) => e.data !== "[DONE]").map((e) => JSON.parse(e.data))
      expect(payloads.filter((p) => p.choices.length === 0)).toHaveLength(
        includeUsage === true ? 1 : 0,
      )
    }
  }
})
test("includeUsage reads the one cached translated parse and passthrough stays unparsed", () => {
  const pair = translationPair("openai-chat", "anthropic")
  expect(pair).not.toBeNull()
  if (pair === null) throw new Error("missing pair")
  const source = {
    model: "m",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true },
  }
  const request = createTranslatedRequestBody(new TextEncoder().encode(JSON.stringify(source)), {
    created: 1,
    model: "m",
    fallbackId: "id",
  })
  expect(request.includeUsage()).toBe(false)
  request.bodyFor(pair, "m", "max_tokens")
  expect(request.includeUsage()).toBe(true)
  expect(request.includeUsage()).toBe(true)
})
