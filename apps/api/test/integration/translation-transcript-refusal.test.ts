import { expect, test } from "bun:test"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

const model = "fixture-model"
function provider(dialect: "openai-chat" | "openai-responses") {
  return account("fixture", {
    provider: dialect === "openai-responses" ? "openai-api" : "openrouter",
    dialect,
    cipher: CRYPTOR,
  })
}
function event(type: string, body: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`
}
test("Responses parallel calls reach a strict Chat upstream as one contiguous tool group", async () => {
  let calls: readonly { readonly body: string }[] = []
  const { app, upstream, usage } = harness({
    accounts: [provider("openai-chat")],
    responses: [
      () => {
        const wire: {
          messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]
        } = JSON.parse(calls[0]?.body ?? "{}")
        expect(wire.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"])
        expect(wire.messages[1]?.tool_calls?.map((c) => c.id)).toEqual(["a", "b"])
        expect(wire.messages.slice(2).map((m) => m.tool_call_id)).toEqual(["b", "a"])
        return jsonResponse(200, {
          id: "fixture",
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        })
      },
    ],
  })
  calls = upstream.calls
  const input = [
    { role: "user", content: "run tools" },
    ...["a", "b"].map((id) => ({
      type: "function_call",
      call_id: id,
      name: `tool_${id}`,
      arguments: "{}",
    })),
    ...["b", "a"].map((id) => ({
      type: "function_call_output",
      call_id: id,
      output: `result_${id}`,
    })),
  ]
  const res = await app.request("/v1/responses", post(JSON.stringify({ model, input }), bearer()))
  expect(res.status).toBe(200)
  await res.text()
  await settle()
  expect(usage.rows).toHaveLength(1)
  expect(usage.rows[0]).toMatchObject({
    outcome: "success",
    egressMode: "translate",
    tokensIn: 7,
    tokensOut: 2,
  })
})
for (const target of ["chat", "anthropic"] as const)
  test(`Responses refusal reaches ${target} client before completion`, async () => {
    const slow = slowStream([
      event("response.created", { response: { id: "fixture", model } }) +
        event("response.refusal.delta", {
          delta: "Cannot comply",
          output_index: 0,
          content_index: 0,
          item_id: "msg",
        }),
      event("response.refusal.done", { refusal: "Cannot comply" }) +
        event("response.completed", {
          response: {
            id: "fixture",
            model,
            status: "completed",
            usage: { input_tokens: 7, output_tokens: 2 },
          },
        }),
    ])
    const { app, usage } = harness({
      accounts: [provider("openai-responses")],
      responses: [() => slow.response],
    })
    const request =
      target === "chat"
        ? { model, stream: true, messages: [{ role: "user", content: "hello" }] }
        : { model, stream: true, max_tokens: 100, messages: [{ role: "user", content: "hello" }] }
    const res = await app.request(
      target === "chat" ? "/v1/chat/completions" : "/v1/messages",
      post(JSON.stringify(request), bearer()),
    )
    expect(res.status).toBe(200)
    if (res.body === null) throw new Error("expected response body")
    const reader = res.body.getReader()
    slow.release(0)
    const early = new TextDecoder().decode((await reader.read()).value)
    expect(early).toContain("Cannot comply")
    expect(early).not.toContain("[DONE]")
    expect(early).not.toContain("message_stop")
    slow.release(1)
    slow.finish()
    let text = early
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += new TextDecoder().decode(chunk.value)
    }
    expect(text.match(/Cannot comply/g)).toHaveLength(1)
    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]?.outcome).toBe("success")
  })
test("declared Responses failure terminates Chat once and remains failed accounting", async () => {
  const body =
    event("response.created", { response: { id: "fixture", model } }) +
    event("response.output_text.delta", { delta: "partial" }) +
    event("response.failed", {
      response: {
        id: "fixture",
        model,
        status: "failed",
        error: { type: "provider_failure", message: "fixture failure" },
      },
    })
  const slow = slowStream([body])
  const { app, usage } = harness({
    accounts: [provider("openai-responses")],
    responses: [() => slow.response],
  })
  const res = await app.request(
    "/v1/chat/completions",
    post(
      JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello" }] }),
      bearer(),
    ),
  )
  slow.release(0)
  slow.finish()
  const text = await res.text()
  await settle()
  expect(text).toContain("fixture failure")
  expect(text).toContain('"finish_reason":"stop"')
  expect(text.match(/data: \[DONE\]/g)).toHaveLength(1)
  expect(usage.rows).toHaveLength(1)
  expect(usage.rows[0]?.outcome).toBe("upstream_error")
})

for (const includeUsage of [undefined, false, true] as const)
  test(`Chat caller usage opt-in ${String(includeUsage)} controls frames without losing accounting`, async () => {
    const slow = slowStream([
      event("response.output_text.delta", { delta: "answer" }) +
        event("response.completed", {
          response: {
            id: "fixture",
            model,
            status: "completed",
            usage: { input_tokens: 7, output_tokens: 2 },
          },
        }),
    ])
    const { app, usage } = harness({
      accounts: [provider("openai-responses")],
      responses: [() => slow.response],
    })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
          stream_options: includeUsage === undefined ? undefined : { include_usage: includeUsage },
        }),
        bearer(),
      ),
    )
    slow.release(0)
    slow.finish()
    const text = await res.text()
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as { choices?: readonly unknown[]; usage?: unknown })
    expect(res.status).toBe(200)
    expect(payloads.filter((p) => p.choices?.length === 0)).toHaveLength(
      includeUsage === true ? 1 : 0,
    )
    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 7, tokensOut: 2 })
  })
