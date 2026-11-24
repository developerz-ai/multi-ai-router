import { describe, expect, test } from "bun:test"
import {
  openAiResponsesToAnthropicStream,
  openAiResponsesToOpenAiChatResponse,
  openAiResponsesToOpenAiChatStream,
} from "../../../src/services/translate"
import {
  chatFinishFromResponses,
  fromResponsesCompletion,
} from "../../../src/services/translate/shared/stop-reason"

/**
 * Prod fingerprint (developerz.ai router 2.76.1, 2026-11-23): 33 `gpt-6.2-sol` answers in 12 h ended
 * `response.incomplete` with `incomplete_details.reason: "max_messages"`, and each was told to its
 * client as a clean `stop` / `end_turn` with an "unrecognized stop reason" warn beside it.
 */
function frame(payload: Record<string, unknown>) {
  return { event: String(payload.type), data: JSON.stringify(payload) }
}

const incomplete = (reason: string) =>
  frame({
    type: "response.incomplete",
    response: {
      id: "resp_1",
      status: "incomplete",
      incomplete_details: { reason },
      usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 },
    },
  })

const opening = [
  frame({ type: "response.created", response: { id: "resp_1", model: "gpt-6.2-sol" } }),
  frame({
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "half an answer",
  }),
]

function finishes(events: readonly { data: string }[]): unknown[] {
  return events
    .map((event) => {
      if (event.data === "[DONE]") return null
      const payload = JSON.parse(event.data)
      return payload.choices?.[0]?.finish_reason ?? payload.delta?.stop_reason ?? null
    })
    .filter((value) => value !== null)
}

describe("an incomplete Responses answer is never told as a clean stop", () => {
  test("`max_messages` is a known reason: `length`, nothing unrecognized", () => {
    expect(fromResponsesCompletion("incomplete", "max_messages", false)).toEqual({
      value: "length",
      unrecognized: null,
    })
    expect(fromResponsesCompletion("incomplete", "max_messages", true)).toEqual(
      fromResponsesCompletion("incomplete", "max_output_tokens", true),
    )
  })

  test("a reason this build does not define maps as `max_output_tokens` does, and is reported", () => {
    expect(fromResponsesCompletion("incomplete", "some_new_reason", false)).toEqual({
      value: "length",
      unrecognized: "some_new_reason",
    })
    expect(fromResponsesCompletion("incomplete", null, true)).toEqual({
      value: "length",
      unrecognized: "incomplete",
    })
    expect(chatFinishFromResponses("incomplete", "some_new_reason", true).value).toBe("length")
  })

  test("the two reasons already defined are unchanged", () => {
    expect(fromResponsesCompletion("incomplete", "max_output_tokens", false).value).toBe("length")
    expect(fromResponsesCompletion("incomplete", "content_filter", false).value).toBe(
      "content_filter",
    )
    expect(fromResponsesCompletion("completed", null, true).value).toBe("tool_calls")
  })

  test("openai-chat client, streamed: finish_reason `length`, no warn", () => {
    const stream = openAiResponsesToOpenAiChatStream({ created: 1 })
    const events = [...opening, incomplete("max_messages")].flatMap((f) => stream.push(f))
    expect(finishes(events)).toEqual(["length"])
    expect(events.at(-1)?.data).toBe("[DONE]")
    expect(stream.unrecognizedStopReason()).toBeNull()
  })

  test("anthropic client, streamed: stop_reason `max_tokens`, and an unknown reason still warns", () => {
    const known = openAiResponsesToAnthropicStream({})
    const first = [...opening, incomplete("max_messages")].flatMap((f) => known.push(f))
    expect(finishes(first)).toEqual(["max_tokens"])
    expect(known.unrecognizedStopReason()).toBeNull()

    const unknown = openAiResponsesToAnthropicStream({})
    const second = [...opening, incomplete("some_new_reason")].flatMap((f) => unknown.push(f))
    expect(finishes(second)).toEqual(["max_tokens"])
    expect(unknown.unrecognizedStopReason()).toBe("some_new_reason")
  })

  test("openai-chat client, not streamed: the same answer", () => {
    const out = openAiResponsesToOpenAiChatResponse(
      {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_messages" },
        output: [{ type: "message", content: [{ type: "output_text", text: "half an answer" }] }],
      },
      { created: 1 },
    )
    expect((out.body as { choices: { finish_reason: string }[] }).choices[0]?.finish_reason).toBe(
      "length",
    )
    expect(out.unrecognizedStopReason).toBeNull()
  })
})
