import { describe, expect, test } from "bun:test"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

/**
 * The `translate` egress mode end to end: an Anthropic client dispatched to an openai-chat
 * account, streaming intact. `dataplane.test.ts` covers the non-streaming direction (M6a/M6b's
 * first landing); this file is the streaming half plus the error and usage guarantees that only
 * show up once bytes are actually flowing incrementally through a translator.
 *
 * Nothing here touches a network: `fetch` is `harness()`'s mocked upstream, same as every other
 * integration suite in this directory.
 */

function openRouterAccount(id = "or-1", overrides: Parameters<typeof account>[1] = {}) {
  return account(id, { provider: "openrouter", apiKey: "sk-or", cipher: CRYPTOR, ...overrides })
}

function openAiChunk(body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o", ...body })}\n\n`
}

const DONE = "data: [DONE]\n\n"

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  return out
}

describe("cross-dialect streaming (translate egress)", () => {
  test("an anthropic request against an openai-chat account comes back as Anthropic SSE with stop_reason and usage", async () => {
    const body =
      openAiChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openAiChunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } }) +
      DONE
    const slow = slowStream([body])
    const { app, upstream, usage } = harness({
      accounts: [openRouterAccount()],
      responses: [() => slow.response],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    slow.release(0)
    slow.finish()
    const text = await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    // Addressed at the account's dialect, at the account's dialect's path.
    expect(upstream.calls[0]?.url).toContain("/chat/completions")
    // Anthropic's own event names and shape — never the openai-chat ones the account spoke.
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: message_delta")
    expect(text).toContain("event: message_stop")
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain('"output_tokens":22')
    expect(text).toContain('"input_tokens":11')

    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "success" })
    expect(usage.rows[0]?.tokensIn).toBeGreaterThan(0)
    expect(usage.rows[0]?.tokensOut).toBeGreaterThan(0)
  })

  test("streams without buffering: the first translated event reaches the client before the upstream sends its next chunk", async () => {
    const first = openAiChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }],
    })
    const second = openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + DONE
    const slow = slowStream([first, second])
    const { app } = harness({ accounts: [openRouterAccount()], responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    const early = new TextDecoder().decode((await reader.read()).value)
    // The first upstream chunk's own content reached the client...
    expect(early).toContain("event: message_start")
    expect(early).toContain('"text_delta"')
    // ...while the second upstream chunk is still gated. A relay that buffered the whole response
    // before writing anything would have nothing to hand back here at all — `reader.read()` above
    // would still be pending on the still-unreleased second chunk instead of resolving now.
    expect(early).not.toContain("message_stop")

    slow.release(1)
    slow.finish()
    const rest = await drain(reader)
    expect(rest).toContain("event: message_stop")
  })

  test("an upstream error from a translated account renders in the client's own dialect and names no account", async () => {
    const { app, upstream } = harness({
      accounts: [openRouterAccount("secret-account-id", { apiKey: "sk-shh" })],
      responses: [
        () =>
          jsonResponse(400, {
            error: {
              message: "temperature must be between 0 and 2",
              type: "invalid_request_error",
              code: "400",
            },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const body = (await res.json()) as Record<string, unknown>
    const rendered = JSON.stringify(body)

    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toBe("application/json")
    // Anthropic's error shape — the client asked `/v1/messages`, even though the account behind it
    // spoke openai-chat and answered in that shape.
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } })
    expect(rendered).toContain("temperature must be between 0 and 2")
    // The account's identity and credential never reach the client, translated or not.
    expect(rendered).not.toContain("secret-account-id")
    expect(rendered).not.toContain("sk-shh")
    expect(upstream.calls).toHaveLength(1)
  })
})
