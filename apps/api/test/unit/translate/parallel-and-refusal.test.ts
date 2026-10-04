import { expect, test } from "bun:test"
import { openAiResponsesToAnthropicStream as anthropic } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatRequest as request } from "../../../src/services/translate/openai-responses-to-openai-chat/request"
import { openAiResponsesToOpenAiChatStream as chat } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"

const call = (id: string) => ({
  type: "function_call",
  call_id: id,
  name: `tool${id}`,
  arguments: "{}",
})
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: id })
test("contiguous parallel calls preserve IDs", () => {
  const r = request({
    model: "fixture",
    input: [call("a"), call("b"), call("c"), output("c"), output("a"), output("b")],
  })
  expect(r.messages.length).toBe(4)
  expect(r.messages[0]?.tool_calls?.map((c) => c.id)).toEqual(["a", "b", "c"])
  expect(r.messages.slice(1).map((m) => m.tool_call_id)).toEqual(["c", "a", "b"])
})
test("assistant text with calls survives and user separates turns", () => {
  const r = request({
    model: "fixture",
    input: [
      { role: "assistant", content: "Before" },
      call("a"),
      { role: "assistant", content: "After" },
      output("a"),
      { role: "user", content: "Next" },
      call("b"),
      output("b"),
    ],
  })
  expect(r.messages[0]?.content).toBe("Before\nAfter")
  expect(r.messages.length).toBe(5)
  expect(r.messages[3]?.tool_calls?.[0]?.id).toBe("b")
})
test("unknown result rejected", () =>
  expect(() => request({ model: "fixture", input: [output("x")] })).toThrow())
for (const [name, make] of [
  ["Chat", () => chat({ created: 0 })],
  ["Anthropic", () => anthropic()],
] as const) {
  test(`${name} refusal delta emits incrementally; done mirror ignored`, () => {
    const t = make()
    for (const delta of ["Cannot ", "comply"]) {
      const events = t.push({
        event: "response.refusal.delta",
        data: JSON.stringify({ type: "response.refusal.delta", delta }),
      })
      expect(events.length).toBeGreaterThan(0)
      expect(JSON.stringify(events)).toContain(delta)
    }
    expect(
      t.push({
        event: "response.refusal.done",
        data: JSON.stringify({ type: "response.refusal.done", refusal: "Cannot comply" }),
      }),
    ).toEqual([])
  })
}
