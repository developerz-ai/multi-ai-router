import { expect, test } from "bun:test"
import type { TranslationDrop } from "../../../src/services/translate"
import {
  openAiChatToAnthropicRequest,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToOpenAiChatRequest,
} from "../../../src/services/translate"

/**
 * `tools: []` is the Responses default and its SDKs state it; openai-chat refuses an empty `tools`
 * ("[] is too short") and a `tool_choice` beside no tools, as Anthropic does. A list the *router*
 * emptied was already omitted with its choice; one the client sent empty went out as written, and
 * the turn was a `400` about a body the router wrote.
 */
const base = { model: "m", input: "hi" }

test("openai-responses -> openai-chat: a client's empty `tools` is omitted, with its mode", () => {
  const auto = openAiResponsesToOpenAiChatRequest({ ...base, tools: [], tool_choice: "auto" })
  expect(auto.tools).toBeUndefined()
  expect(auto.tool_choice).toBeUndefined()
  // The caller's explicit word is kept (`translation-tool-contracts.test.ts`); only the list goes.
  const none = openAiResponsesToOpenAiChatRequest({ ...base, tools: [], tool_choice: "none" })
  expect(none.tools).toBeUndefined()
  expect(none.tool_choice).toBe("none")
  const drops: TranslationDrop[] = []
  const out = openAiResponsesToOpenAiChatRequest(
    { ...base, tools: [], tool_choice: "required", parallel_tool_calls: true },
    { onDrop: (drop) => void drops.push(drop) },
  )
  expect(out.tools).toBeUndefined()
  expect(out.tool_choice).toBeUndefined()
  expect(out.parallel_tool_calls).toBeUndefined()
  expect(drops.map((drop) => drop.field)).toEqual(["tool_choice"])
})

test("openai-responses -> anthropic: the same list and mode never reach the upstream", () => {
  const out = openAiResponsesToAnthropicRequest({ ...base, tools: [], tool_choice: "auto" })
  expect(out.tools).toBeUndefined()
  expect(out.tool_choice).toBeUndefined()
})

test("no `tools` at all is the client's own shape and passes as it always did", () => {
  const out = openAiResponsesToOpenAiChatRequest({ ...base, tool_choice: "auto" })
  expect(out.tool_choice).toBe("auto")
})

test("openai-chat -> anthropic: `image/jpg` is the JPEG media type Anthropic names `image/jpeg`", () => {
  const out = openAiChatToAnthropicRequest({
    model: "m",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/jpg;base64,AAAA" } }],
      },
    ],
  })
  expect(out.messages[0]?.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
  ])
})
