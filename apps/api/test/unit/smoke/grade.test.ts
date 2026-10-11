import { describe, expect, test } from "bun:test"
import {
  grade,
  type LegSpec,
  type MessagesLeg,
  type OpenAiLeg,
  type StreamEvent,
} from "../../../smoke/grade"

/**
 * The grader is the contract. These tests pin the verdict for every documented shape and the
 * ones a leg might still meet on a healthy router, so a refactor that flips a verdict fails here
 * before it ships.
 */

function messagesLeg(expectation: MessagesLeg["expectation"], stream = false): MessagesLeg {
  return { endpoint: "/v1/messages", stream, name: "test", expectation }
}

function chatLeg(expectation: OpenAiLeg["expectation"]): OpenAiLeg {
  return {
    endpoint: "/v1/chat/completions",
    stream: false,
    name: "test",
    expectation,
    required: false,
  }
}

function responsesLeg(expectation: OpenAiLeg["expectation"]): OpenAiLeg {
  return { endpoint: "/v1/responses", stream: false, name: "test", expectation, required: false }
}

describe("grade — text leg", () => {
  test("PASS on a 200 with stop_reason end_turn and a text block", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "pong" }],
    })
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL when stop_reason is wrong and there is no text", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "" }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("truncated")
  })

  test("FAIL on a 4xx with the upstream error message surfaced", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 401, {
      type: "error",
      error: { type: "authentication_error", message: "bad key" },
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("http-401")
  })

  test("FAIL on a non-object body", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, "not-json-at-all")
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("unparsable-body")
  })
})

describe("grade — forced tool leg", () => {
  test("PASS on stop_reason tool_use with the named tool_use block", () => {
    const outcome = grade(messagesLeg({ kind: "forced_tool", name: "get_weather" }), 200, {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
    })
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL on prose where a tool was forced", () => {
    const outcome = grade(messagesLeg({ kind: "forced_tool", name: "get_weather" }), 200, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Sure!" }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("stop-end_turn")
    expect(outcome.reason).toContain("missing-tool-use")
  })

  test("FAIL on max_tokens stop_reason as truncated, not as a tool failure", () => {
    const outcome = grade(messagesLeg({ kind: "forced_tool", name: "get_weather" }), 200, {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "get_weather", input: {} }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("truncated")
  })

  test("FAIL when stop_reason is tool_use but the tool name does not match", () => {
    const outcome = grade(messagesLeg({ kind: "forced_tool", name: "get_weather" }), 200, {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "wrong_tool", input: {} }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("wrong-tool")
  })
})

describe("grade — tool_choice any", () => {
  test("PASS on stop_reason tool_use with any tool_use block", () => {
    const outcome = grade(messagesLeg({ kind: "tool_choice_any" }), 200, {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "anything", input: {} }],
    })
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL on prose when the policy said any tool", () => {
    const outcome = grade(messagesLeg({ kind: "tool_choice_any" }), 200, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "nothing" }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("missing-tool-use")
  })
})

describe("grade — tool round trip", () => {
  test("PASS on a non-empty response with tool_result in history", () => {
    const outcome = grade(messagesLeg({ kind: "tool_round_trip" }), 200, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "18°C" }],
    })
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL on an empty round-trip response", () => {
    const outcome = grade(messagesLeg({ kind: "tool_round_trip" }), 200, {
      stop_reason: "end_turn",
      content: [],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("empty-round-trip-response")
  })

  test("FAIL on a 4xx — the router refused the round trip", () => {
    const outcome = grade(messagesLeg({ kind: "tool_round_trip" }), 400, {
      type: "error",
      error: { type: "invalid_request_error", message: "missing tool_use_id" },
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("http-400")
  })
})

describe("grade — streamed forced tool", () => {
  test("PASS when message_delta carries stop_reason tool_use and a tool_use block was opened", () => {
    const events: StreamEvent[] = [
      {
        event: "content_block_start",
        data: {
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "get_weather", input: {} },
        },
      },
      {
        event: "message_delta",
        data: { delta: { stop_reason: "tool_use" } },
      },
      { event: "message_stop", data: {} },
    ]
    const outcome = grade(
      messagesLeg({ kind: "streamed_forced_tool", name: "get_weather" }, true),
      200,
      undefined,
      events,
    )
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL on a stream whose final stop_reason is end_turn", () => {
    const events: StreamEvent[] = [
      {
        event: "content_block_start",
        data: { index: 0, content_block: { type: "text", text: "" } },
      },
      {
        event: "message_delta",
        data: { delta: { stop_reason: "end_turn" } },
      },
    ]
    const outcome = grade(
      messagesLeg({ kind: "streamed_forced_tool", name: "get_weather" }, true),
      200,
      undefined,
      events,
    )
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("stop-end_turn")
  })

  test("FAIL on a stream whose only stop_reason is max_tokens", () => {
    const events: StreamEvent[] = [
      {
        event: "content_block_start",
        data: { index: 0, content_block: { type: "tool_use", name: "get_weather", input: {} } },
      },
      { event: "message_delta", data: { delta: { stop_reason: "max_tokens" } } },
    ]
    const outcome = grade(
      messagesLeg({ kind: "streamed_forced_tool", name: "get_weather" }, true),
      200,
      undefined,
      events,
    )
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("truncated")
  })
})

describe("grade — reasoning + forced tool", () => {
  test("PASS on a thinking block plus a tool_use block with the expected name", () => {
    const outcome = grade(
      messagesLeg({ kind: "reasoning_forced_tool", name: "get_weather" }),
      200,
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "user asked about Paris weather" },
          { type: "tool_use", name: "get_weather", input: { city: "Paris" } },
        ],
      },
    )
    expect(outcome).toEqual({ verdict: "PASS", thinkingPresent: true })
  })

  test("PASS on a tool_use block with no thinking block — adaptive thinking is optional", () => {
    // Per the Luna spec: adaptive thinking makes the thinking block optional. The grader
    // grades on the tool call alone and reports thinking presence as information.
    const outcome = grade(
      messagesLeg({ kind: "reasoning_forced_tool", name: "get_weather" }),
      200,
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "get_weather", input: { city: "Paris" } }],
      },
    )
    expect(outcome).toEqual({ verdict: "PASS", thinkingPresent: false })
  })

  test("FAIL when stop_reason is wrong and there is no tool_use", () => {
    const outcome = grade(
      messagesLeg({ kind: "reasoning_forced_tool", name: "get_weather" }),
      200,
      {
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "the user asked about weather" }],
      },
    )
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toContain("stop-end_turn")
    expect(outcome.reason).toContain("missing-tool-use")
  })
})

describe("grade — malformed body", () => {
  test("FAIL with reason malformed-body when content is a string", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, {
      stop_reason: "end_turn",
      content: "not-an-array",
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("malformed-body")
  })

  test("FAIL with reason malformed-body when content is an array containing null", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, {
      stop_reason: "end_turn",
      content: [null],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("malformed-body")
  })

  test("FAIL with reason malformed-body when content is null", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, {
      stop_reason: "end_turn",
      content: null,
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("malformed-body")
  })

  test("FAIL with reason malformed-body when a content block has no string type", () => {
    const outcome = grade(messagesLeg({ kind: "text" }), 200, {
      stop_reason: "end_turn",
      content: [{ type: 42 }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("malformed-body")
  })
})

describe("grade — chat completions required tool", () => {
  test("PASS on finish_reason tool_calls with at least one tool_calls entry", () => {
    const outcome = grade(chatLeg({ kind: "chat_completions_required_tool" }), 200, {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              { id: "x", type: "function", function: { name: "get_weather", arguments: "{}" } },
            ],
          },
        },
      ],
    })
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL on finish_reason stop — the router did not enforce the required tool", () => {
    const outcome = grade(chatLeg({ kind: "chat_completions_required_tool" }), 200, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "no thanks" } }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("finish-stop")
  })

  test("FAIL on an empty tool_calls array", () => {
    const outcome = grade(chatLeg({ kind: "chat_completions_required_tool" }), 200, {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [] } }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("no-tool-calls")
  })
})

describe("grade — /v1/responses function call", () => {
  test("PASS on an output array with a function_call item", () => {
    const outcome = grade(responsesLeg({ kind: "responses_function_call" }), 200, {
      output: [
        {
          type: "function_call",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
      ],
    })
    expect(outcome).toEqual({ verdict: "PASS" })
  })

  test("FAIL when the output array has no function_call item", () => {
    const outcome = grade(responsesLeg({ kind: "responses_function_call" }), 200, {
      output: [{ type: "message", content: [] }],
    })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("no-function-call")
  })

  test("FAIL when the output array is empty", () => {
    const outcome = grade(responsesLeg({ kind: "responses_function_call" }), 200, { output: [] })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.reason).toBe("no-output")
  })
})

describe("grade — error shapes", () => {
  test("PASS the leg to /v1/messages is unparsable as something other than an object", () => {
    // grade is strict about shape; the runner, not the grader, decides INCONCLUSIVE.
    const outcome = grade(messagesLeg({ kind: "text" }), 200, 42)
    expect(outcome.verdict).toBe("FAIL")
  })

  test("LegSpec union: messages, chat completions and responses each have one verdict path", () => {
    // Compile-time-ish: pin that the same grade() call shape works for every endpoint.
    const legs: readonly LegSpec[] = [
      messagesLeg({ kind: "text" }),
      chatLeg({ kind: "chat_completions_required_tool" }),
      responsesLeg({ kind: "responses_function_call" }),
    ]
    for (const leg of legs) {
      const outcome = grade(leg, 500, { error: { message: "boom" } })
      expect(outcome.verdict).toBe("FAIL")
    }
  })
})
