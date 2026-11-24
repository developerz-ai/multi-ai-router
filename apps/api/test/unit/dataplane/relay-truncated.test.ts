/**
 * A translated stream whose upstream closed cleanly with no ending. The client was left with a
 * stream that just stopped, and the row said `success` (prod 2026-11-24, one conversation retried the
 * same turn 26 times in twelve minutes). It is told once, and the row says what happened.
 */
import { describe, expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { account, catalog, cipher, usageSink } from "./fixtures"

const CRYPTOR = cipher()
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "g", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

async function answer(body: string) {
  const usage = usageSink()
  const health = createHealthStore()
  const dispatcher = createDispatcher({
    catalog: catalog([account("a", { provider: "openrouter", cipher: CRYPTOR })]),
    cipher: CRYPTOR,
    health,
    usage,
    fetch: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  })
  const response = await dispatcher.dispatch({
    ingress: "anthropic",
    requestId: "req",
    key: {
      id: "key",
      name: "k",
      prefix: "k",
      scope: { kind: "all" },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  })
  return { text: await response.text(), rows: usage.rows, health }
}

describe("a translated stream that ends with no final event", () => {
  test("ends with exactly one error event and is not recorded as a success", async () => {
    const { text, rows, health } = await answer(chunk({ role: "assistant", content: "half" }))

    expect(text.match(/event: error/g)).toHaveLength(1)
    expect(text).not.toContain("message_stop")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: "upstream_error",
      errorClass: "upstream_incomplete",
      streamed: true,
    })
    expect(health.stateOf("a").breaker.consecutiveFailures).toBe(0)
  })

  test("one that stated its finish reason but no terminator is whole, and stays a success", async () => {
    const { text, rows } = await answer(chunk({ content: "all" }) + chunk({}, "stop"))

    expect(text).toContain("message_stop")
    expect(text).not.toContain("event: error")
    expect(rows[0]).toMatchObject({ outcome: "success" })
  })

  test("one that says nothing the client can read is an error event, never an empty 200", async () => {
    // An upstream answering a chat stream in another shape: every frame was dropped, the client got
    // a `200` with no events, and the row said `usage_unreported` (found by the bench, 2026-11-24).
    const { text, rows } = await answer(
      'data: {"type":"response.output_text.delta","delta":"x"}\n\n',
    )

    expect(text.match(/event: error/g)).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: "upstream_error",
      errorClass: "upstream_incomplete",
      costEstimate: null,
      costBasis: "unknown",
    })
  })
})
