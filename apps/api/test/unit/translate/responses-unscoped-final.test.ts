import { expect, test } from "bun:test"
import { openAiResponsesToAnthropicStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatStream } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"
import type { StreamTranslator } from "../../../src/services/translate/sse/emit"

function send(translator: StreamTranslator, payload: object) {
  return translator.push({ event: null, data: JSON.stringify(payload) })
}

for (const dialect of ["chat", "anthropic"] as const) {
  test(`${dialect}: ignores an unscoped final item mirror without discarding live unkeyed arguments`, () => {
    const translator =
      dialect === "chat"
        ? openAiResponsesToOpenAiChatStream({ created: 1 })
        : openAiResponsesToAnthropicStream()
    const item = { type: "function_call", call_id: "call-a", name: "f", arguments: "" }
    const live = [
      ...send(translator, { type: "response.output_item.added", item }),
      ...send(translator, { type: "response.function_call_arguments.delta", delta: "{}" }),
    ]
    expect(
      send(translator, { type: "response.output_item.done", item: { ...item, arguments: "{}" } }),
    ).toEqual([])
    const terminal = send(translator, {
      type: "response.completed",
      response: { status: "completed" },
    })
    const events = [...live, ...terminal]
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data))
    const calls =
      dialect === "chat"
        ? events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
        : events.filter(
            (e) => e.type === "content_block_start" && e.content_block.type === "tool_use",
          )
    expect(
      calls.filter((c) =>
        dialect === "chat" ? c.id === "call-a" : c.content_block.id === "call-a",
      ),
    ).toHaveLength(1)
    const argumentsText =
      dialect === "chat"
        ? calls.map((c) => c.function.arguments ?? "").join("")
        : events.map((e) => e.delta?.partial_json ?? "").join("")
    expect(argumentsText).toBe("{}")
    expect(translator.translationFailure?.()).toBeNull()
  })
}
