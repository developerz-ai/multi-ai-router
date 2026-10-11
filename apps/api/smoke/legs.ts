/**
 * The eight legs `bin/smoke` drives and the request body each one sends. Pure data plus body
 * builders that match the leg's expectation kind and endpoint. `grade.ts` reads the legs;
 * nothing else does.
 *
 * The `required` flag gates the exit code: every Messages leg is required, and the two OpenAI
 * legs are informational (an account may legitimately refuse them). The flag lives on every leg
 * (not on a separate list) so the runner decides from the leg itself.
 */

import type { LegSpec, MessagesExpectation, OpenAiExpectation } from "./grade"

export const TOOL_NAME = "get_weather"

export const REQUIRED_LEG_NAMES: readonly string[] = [
  "messages.text",
  "messages.forced_tool",
  "messages.tool_choice_any",
  "messages.tool_round_trip",
  "messages.streamed_forced_tool",
  "messages.reasoning_forced_tool",
]

export function buildLegs(): readonly LegSpec[] {
  const messages: readonly LegSpec[] = REQUIRED_LEG_NAMES.map((name) => ({
    endpoint: "/v1/messages" as const,
    stream: name === "messages.streamed_forced_tool",
    name,
    expectation: expectationForMessages(name),
    required: true,
  }))
  const informational: readonly LegSpec[] = [
    {
      endpoint: "/v1/chat/completions",
      stream: false,
      name: "chat_completions.required_tool",
      expectation: { kind: "chat_completions_required_tool" },
      required: false,
    },
    {
      endpoint: "/v1/responses",
      stream: false,
      name: "responses.function_call",
      expectation: { kind: "responses_function_call" },
      required: false,
    },
  ]
  return [...messages, ...informational]
}

function expectationForMessages(name: string): MessagesExpectation {
  switch (name) {
    case "messages.text":
      return { kind: "text" }
    case "messages.forced_tool":
      return { kind: "forced_tool", name: TOOL_NAME }
    case "messages.tool_choice_any":
      return { kind: "tool_choice_any" }
    case "messages.tool_round_trip":
      return { kind: "tool_round_trip" }
    case "messages.streamed_forced_tool":
      return { kind: "streamed_forced_tool", name: TOOL_NAME }
    case "messages.reasoning_forced_tool":
      return { kind: "reasoning_forced_tool", name: TOOL_NAME }
    default:
      throw new Error(`unknown messages leg: ${name}`)
  }
}

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: "Return the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
}

export function buildBody(leg: LegSpec, model: string): unknown {
  if (leg.endpoint === "/v1/messages") return buildMessagesBody(leg.expectation, model)
  if (leg.endpoint === "/v1/chat/completions")
    return buildChatCompletionsBody(leg.expectation, model)
  return buildResponsesBody(leg.expectation, model)
}

function buildMessagesBody(expectation: MessagesExpectation, model: string): unknown {
  switch (expectation.kind) {
    case "text":
      return {
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      }
    case "forced_tool":
      return {
        model,
        max_tokens: 64,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "tool", name: expectation.name },
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
      }
    case "tool_choice_any":
      return {
        model,
        max_tokens: 64,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: "Anything you can do." }],
      }
    case "tool_round_trip":
      return {
        model,
        max_tokens: 64,
        tools: [TOOL_DEFINITION],
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_round_trip_1",
                name: TOOL_NAME,
                input: { city: "Paris" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_round_trip_1",
                content: '{"temperature_c":18}',
              },
            ],
          },
        ],
      }
    case "streamed_forced_tool":
      return {
        model,
        max_tokens: 64,
        stream: true,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "tool", name: expectation.name },
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }
    case "reasoning_forced_tool":
      return {
        model,
        max_tokens: 256,
        // Adaptive thinking makes the reasoning block optional: the model may emit a thinking
        // block or skip straight to the tool call, and either is the spec-live shape #178 proved
        // on 2026-10-11. The Responses-translated route carries no thinking block at all when the
        // upstream returns no summary text, so the grader PASSes on the tool call alone.
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "tool", name: expectation.name },
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }
  }
}

function buildChatCompletionsBody(
  _expectation: Extract<OpenAiExpectation, { kind: "chat_completions_required_tool" }>,
  model: string,
): unknown {
  return {
    model,
    tools: [
      {
        type: "function",
        function: {
          name: TOOL_NAME,
          description: "Return the current weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: "required",
    messages: [{ role: "user", content: "Weather in Paris?" }],
  }
}

function buildResponsesBody(expectation: OpenAiExpectation, model: string): unknown {
  if (expectation.kind !== "responses_function_call") {
    throw new Error("internal: buildResponsesBody called for non-Responses leg")
  }
  return {
    model,
    tools: [
      {
        type: "function",
        name: TOOL_NAME,
        description: "Return the current weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    input: "Weather in Paris?",
  }
}
