import { expect, test } from "bun:test"
import {
  openAiChatToAnthropicResponse,
  openAiChatToAnthropicStream,
  openAiChatToOpenAiResponsesResponse,
  openAiChatToOpenAiResponsesStream,
} from "../../../src/services/translate"

/**
 * An openai-chat upstream states a refusal in its own field (`message.refusal`, `delta.refusal`).
 * Read as absent, the client of another dialect got an empty answer under a clean stop: the model
 * declined out loud and the sentence it declined with was dropped. The Responses reading never
 * drops one (`refusal-parity.test.ts`); this is the same rule for the openai-chat reading.
 */
const completion = {
  id: "chatcmpl-1",
  model: "m",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, refusal: "I can't help with that." },
      finish_reason: "stop",
    },
  ],
}
const chunks = [
  { id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "", refusal: null } }] },
  { id: "c", choices: [{ index: 0, delta: { refusal: "I can't " } }] },
  { id: "c", choices: [{ index: 0, delta: { refusal: "help with that." } }] },
  { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map((chunk) => ({ event: null, data: JSON.stringify(chunk) }))
const done = { event: null, data: "[DONE]" }

test("anthropic client: a chat upstream's refusal is the answer text, streamed and collected", () => {
  const body = openAiChatToAnthropicResponse(completion, {}).body as {
    content: { type: string; text?: string }[]
  }
  expect(body.content).toEqual([{ type: "text", text: "I can't help with that." }])

  const stream = openAiChatToAnthropicStream({})
  const text = [...chunks, done]
    .flatMap((frame) => stream.push(frame))
    .map((event) => JSON.parse(event.data))
    .filter((payload) => payload.delta?.type === "text_delta")
    .map((payload) => payload.delta.text)
    .join("")
  expect(text).toBe("I can't help with that.")
})

test("openai-responses client: a chat upstream's refusal is carried, streamed and collected", () => {
  const body = openAiChatToOpenAiResponsesResponse(completion, { created: 1 }).body
  expect(JSON.stringify(body)).toContain("I can't help with that.")

  const stream = openAiChatToOpenAiResponsesStream({ created: 1 })
  const events = [...chunks, done].flatMap((frame) => stream.push(frame))
  const completed = events
    .map((event) => JSON.parse(event.data))
    .find((payload) => payload.type === "response.completed")
  expect(JSON.stringify(completed.response.output)).toContain("I can't help with that.")
})

test("content beside a refusal keeps both, answer first", () => {
  const body = openAiChatToAnthropicResponse(
    {
      ...completion,
      choices: [
        {
          index: 0,
          message: { content: "Answer", refusal: "Cannot comply" },
          finish_reason: "stop",
        },
      ],
    },
    {},
  ).body as { content: { text?: string }[] }
  expect(body.content.map((block) => block.text).join("\n")).toBe("Answer\nCannot comply")
})
