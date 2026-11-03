import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * 2026-11-03: Claude through router → OpenRouter got zero cache breakpoints, because the
 * Anthropic → openai-chat translation stripped every `cache_control`. OpenRouter's surface states it
 * carries the marker; every other openai-chat vendor keeps the strip. The upstream is a mock.
 */

function chatCompletion(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "anthropic/claude-sonnet-4.5",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

const BODY = JSON.stringify({
  model: "anthropic/claude-sonnet-4.5",
  max_tokens: 64,
  system: [{ type: "text", text: "you are a coding agent", cache_control: { type: "ephemeral" } }],
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "fix the bug", cache_control: { type: "ephemeral" } }],
    },
  ],
})

async function sent(provider: "openrouter" | "deepseek"): Promise<string> {
  const { app, upstream } = harness({
    accounts: [account("a", { provider, cipher: CRYPTOR })],
    responses: [chatCompletion],
  })
  const res = await app.request("/v1/messages", post(BODY, bearer()))
  expect(res.status).toBe(200)
  await res.text()
  expect(upstream.calls).toHaveLength(1)
  return upstream.calls[0]?.body ?? ""
}

describe("anthropic messages → openai-chat: cache breakpoints follow the surface", () => {
  test("openrouter: both breakpoints reach the upstream on their content parts", async () => {
    const body = JSON.parse(await sent("openrouter")) as {
      messages: { role: string; content: unknown }[]
    }
    expect(body.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "you are a coding agent", cache_control: { type: "ephemeral" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "fix the bug", cache_control: { type: "ephemeral" } }],
      },
    ])
  })

  test("a strict openai-chat vendor is never sent the field", async () => {
    expect(await sent("deepseek")).not.toContain("cache_control")
  })
})
