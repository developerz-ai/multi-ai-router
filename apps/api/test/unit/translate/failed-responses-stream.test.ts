import { expect, test } from "bun:test"
import { openAiResponsesToOpenAiChatStream as make } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"

for (const kind of ["response.failed", "error"] as const) {
  test(`${kind} closes failed Chat protocol once with error, conservative finish and sentinel`, () => {
    const stream = make({ created: 0 })
    stream.push({
      event: "response.created",
      data: JSON.stringify({
        type: "response.created",
        response: { id: "fixture", model: "fixture" },
      }),
    })
    const text = stream.push({
      event: "response.output_text.delta",
      data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
    })
    expect(text).toHaveLength(1)
    const error = { type: "provider_failure", message: "failed" }
    const frames = stream.push({
      event: kind,
      data: JSON.stringify(
        kind === "error" ? { type: kind, error } : { type: kind, response: { error } },
      ),
    })
    expect(frames).toHaveLength(3)
    const first: { error?: unknown } = JSON.parse(frames[0]?.data ?? "null")
    expect(first.error).toBeDefined()
    const terminal: { choices: { delta: Record<string, unknown>; finish_reason: string }[] } =
      JSON.parse(frames[1]?.data ?? "null")
    expect(terminal.choices[0]?.finish_reason).toBe("stop")
    expect(terminal.choices[0]?.delta).toEqual({})
    expect(frames[2]?.data).toBe("[DONE]")
    expect(stream.flush()).toEqual([])
    expect(
      stream.push({
        event: "response.completed",
        data: JSON.stringify({ type: "response.completed" }),
      }),
    ).toEqual([])
  })
}
test("EOF without stated terminal failure does not fabricate a finish", () => {
  const stream = make({ created: 0 })
  stream.push({
    event: "response.output_text.delta",
    data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
  })
  expect(stream.flush()).toEqual([])
})
