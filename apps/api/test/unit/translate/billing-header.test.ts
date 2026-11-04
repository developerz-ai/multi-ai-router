/**
 * Claude Code's first system block carries `cch=<checksum>`, new every request. Toward an OpenAI
 * dialect it would lead `instructions`, so no prefix cache upstream could ever hit.
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequest,
} from "../../../src/services/translate"

const header = (cch: string) => ({
  type: "text",
  text: `x-anthropic-billing-header: cc_version=2.1.301.abc; cc_entrypoint=cli; cch=${cch};`,
})
const body = (system: unknown[], text = "hi"): Record<string, unknown> => ({
  model: "m",
  max_tokens: 10,
  system,
  messages: [{ role: "user", content: text }],
})
const PROMPT = { type: "text", text: "You are Claude Code." }

describe("billing header", () => {
  test("a leading header yields the same upstream body as no header, whatever its cch", () => {
    for (const translate of [anthropicToOpenAiChatRequest, anthropicToOpenAiResponsesRequest]) {
      const bare = JSON.stringify(translate(body([PROMPT]) as never))
      expect(JSON.stringify(translate(body([header("aaaaa"), PROMPT]) as never))).toBe(bare)
      expect(JSON.stringify(translate(body([header("bbbbb"), PROMPT]) as never))).toBe(bare)
    }
  })

  test("a header as the only system content leaves no system at all", () => {
    const chat = anthropicToOpenAiChatRequest(body([header("aaaaa")]) as never)
    expect(JSON.stringify(chat)).not.toContain("billing")
    expect(chat.messages.some((m) => m.role === "system")).toBe(false)
    expect(
      anthropicToOpenAiResponsesRequest(body([header("aaaaa")]) as never).instructions,
    ).toBeUndefined()
  })

  test("a request without the header is untouched", () => {
    const chat = anthropicToOpenAiChatRequest(
      body([PROMPT, { type: "text", text: "more" }]) as never,
    )
    expect(JSON.stringify(chat)).toContain("You are Claude Code.")
    expect(JSON.stringify(chat)).toContain("more")
  })

  test("the header text mid-conversation or mid-system is untouched", () => {
    const quoted = "x-anthropic-billing-header: quoted by the user"
    const chat = anthropicToOpenAiChatRequest(
      body([PROMPT, { type: "text", text: `see ${quoted}` }], quoted) as never,
    )
    const json = JSON.stringify(chat)
    expect(json).toContain(`see ${quoted}`)
    expect(json.split(quoted).length - 1).toBe(2)
  })

  test("toward a cache_control surface the header is not a system part either", () => {
    const marked = { ...PROMPT, cache_control: { type: "ephemeral" } }
    const bare = anthropicToOpenAiChatRequest(body([marked]) as never, { cacheControl: true })
    const withHeader = anthropicToOpenAiChatRequest(body([header("aaaaa"), marked]) as never, {
      cacheControl: true,
    })
    expect(JSON.stringify(withHeader)).toBe(JSON.stringify(bare))
  })
})
