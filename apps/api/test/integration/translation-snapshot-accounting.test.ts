import { expect, test } from "bun:test"
import { account, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

function event(type: string, fields: object) {
  return `data: ${JSON.stringify({ type, ...fields })}\n\n`
}
test("snapshot disagreement preserves HTTP status but records one local translation failure without account strike", async () => {
  const slow = slowStream([
    event("response.output_text.delta", { item_id: "msg", content_index: 0, delta: "first" }),
    event("response.output_text.done", { item_id: "msg", content_index: 0, text: "different" }),
    event("response.completed", {
      response: { status: "completed", usage: { input_tokens: 3, output_tokens: 5 } },
    }),
  ])
  const { app, usage, health, upstream } = harness({
    accounts: [
      account("snapshot", { provider: "openai-api", dialect: "openai-responses", cipher: CRYPTOR }),
    ],
    responses: [() => slow.response],
  })
  const res = await app.request(
    "/v1/chat/completions",
    post(
      JSON.stringify({
        model: "fixture",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      bearer(),
    ),
  )
  expect(res.status).toBe(200)
  if (res.body === null) throw new Error("missing body")
  const reader = res.body.getReader()
  slow.release(0)
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("first")
  slow.release(1)
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "translation_protocol_error",
  )
  await settle()
  expect(usage.rows).toHaveLength(1)
  expect(usage.rows[0]).toMatchObject({
    outcome: "router_error",
    errorClass: "translation_protocol_error",
    httpStatus: 200,
    responseStatus: 200,
    streamed: true,
  })
  const state = health.entries().get("snapshot")
  expect(state?.breaker.consecutiveFailures ?? 0).toBe(0)
  slow.release(2)
  slow.finish()
  while (!(await reader.read()).done) {}
  await settle()
  expect(usage.rows).toHaveLength(1)
  expect(upstream.calls).toHaveLength(1)
})

test("deferred-fragment overflow records one router error and leaves account health untouched", async () => {
  const body = `${[
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call", function: { name: "f", arguments: "{" } }],
          },
        },
      ],
    },
    { choices: [{ delta: { content: "x".repeat(1_048_577) } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("")}data: [DONE]\n\n`
  const slow = slowStream([body])
  const { app, usage, health, upstream } = harness({
    accounts: [
      account("overflow", { provider: "openrouter", dialect: "openai-chat", cipher: CRYPTOR }),
    ],
    responses: [() => slow.response],
  })
  const res = await app.request(
    "/v1/messages",
    post(
      JSON.stringify({
        model: "fixture",
        stream: true,
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
      bearer(),
    ),
  )
  slow.release(0)
  slow.finish()
  const wire = await res.text()
  await settle()
  expect(res.status).toBe(200)
  expect(wire).toContain("Translation pending fragments exceed their configured limit")
  expect(wire).not.toContain("message_stop")
  expect(usage.rows).toHaveLength(1)
  expect(usage.rows[0]).toMatchObject({
    outcome: "router_error",
    errorClass: "translation_pending_overflow",
    httpStatus: 200,
    responseStatus: 200,
  })
  expect(health.entries().get("overflow")?.breaker.consecutiveFailures ?? 0).toBe(0)
  expect(upstream.calls).toHaveLength(1)
})
