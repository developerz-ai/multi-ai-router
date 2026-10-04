import { expect, test } from "bun:test"
import { account, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

function event(type: string, fields: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}
test("Anthropic pending overflow relays unchanged HTTP200 with exactly one local failure and no strike", async () => {
  const body = [
    event("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "call", name: "f" },
    }),
    event("content_block_delta", {
      index: 1,
      delta: { type: "text_delta", text: "x".repeat(1048577) },
    }),
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    event("message_stop", {}),
  ].join("")
  const slow = slowStream([body])
  const { app, usage, health, upstream } = harness({
    accounts: [account("overflow", { provider: "anthropic-api", cipher: CRYPTOR })],
    responses: [() => slow.response],
  })
  const response = await app.request(
    "/v1/responses",
    post(JSON.stringify({ model: "fixture", stream: true, input: "hello" }), bearer()),
  )
  slow.release(0)
  slow.finish()
  const wire = await response.text()
  await settle()
  expect(response.status).toBe(200)
  expect(wire).toContain("translation_pending_overflow")
  expect(wire).not.toContain("response.completed")
  expect(usage.rows).toHaveLength(1)
  expect(usage.rows[0]).toMatchObject({
    outcome: "router_error",
    errorClass: "translation_pending_overflow",
    httpStatus: 200,
    responseStatus: 200,
    streamed: true,
  })
  expect(health.entries().get("overflow")?.breaker.consecutiveFailures ?? 0).toBe(0)
  expect(upstream.calls).toHaveLength(1)
})
