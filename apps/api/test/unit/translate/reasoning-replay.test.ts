import { expect, test } from "bun:test"
import { openAiChatToOpenAiResponsesResponse } from "../../../src/services/translate/openai-chat-to-openai-responses/response"
import { openAiResponsesToAnthropicRequest as anthropic } from "../../../src/services/translate/openai-responses-to-anthropic/request"
import { openAiResponsesToOpenAiChatRequest as chat } from "../../../src/services/translate/openai-responses-to-openai-chat/request"

const emitted = openAiChatToOpenAiResponsesResponse(
  {
    id: "fixture",
    model: "fixture",
    choices: [
      {
        index: 0,
        message: { content: "Answer", reasoning_content: "private reasoning summary" },
        finish_reason: "stop",
      },
    ],
  },
  { created: 0 },
).body as { output: unknown[] }
for (const [name, translate] of [
  ["chat", chat],
  ["anthropic", anthropic],
] as const) {
  test(`${name} replays actual router-emitted stateless reasoning without leaking summary`, () => {
    expect(
      emitted.output.some(
        (item) =>
          typeof item === "object" && item !== null && "type" in item && item.type === "reasoning",
      ),
    ).toBe(true)
    const result = translate({
      model: "fixture",
      input: [{ role: "user", content: "Question" }, ...emitted.output],
    })
    expect(JSON.stringify(result)).toContain("Answer")
    expect(JSON.stringify(result)).not.toContain("private reasoning summary")
  })
  test(`${name} refuses encrypted state and item references`, () => {
    for (const item of [
      { type: "reasoning", encrypted_content: "opaque" },
      { type: "reasoning", encrypted_content: {} },
      { type: "item_reference", id: "stored" },
    ]) {
      expect(() => translate({ model: "fixture", input: [item] })).toThrow()
    }
  })
}
