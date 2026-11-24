import { describe, expect, test } from "bun:test"
import type { Dialect } from "@multi-ai-router/core"
import { relayResponse } from "../../../src/services/dataplane/relay"
import { routerErrorEnding } from "../../../src/services/dataplane/relay-stream-end"

/**
 * Plan 101, 13.5: a stream that breaks after its first byte ends with one router error event whose
 * verdict is machine-readable at the path each SDK preserves. This pins those paths per dialect,
 * the contract `docs/clients.md` documents.
 */

function breaking(): Response {
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError("socket closed"))
        return
      }
      sent = true
      controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"))
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

async function lastData(ingress: Dialect): Promise<Record<string, unknown>> {
  const facts = { requestId: "req-1", attempt: 1, accountId: "acct-1" }
  const ending = routerErrorEnding(ingress, facts, undefined)
  const response = relayResponse(breaking(), {}, undefined, ending)
  const data = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]" && line !== "data: {}")
  return JSON.parse(data.at(-1)?.slice(6) ?? "{}") as Record<string, unknown>
}

describe("the mid-stream router error keeps its type", () => {
  test("anthropic: error.router on the `error` event", async () => {
    const event = await lastData("anthropic")
    expect(event).toMatchObject({
      type: "error",
      error: { router: { wall: "capacity", retryable: true, signal: "upstream_error" } },
    })
  })

  test("openai-chat: error.router on the error chunk, before [DONE]", async () => {
    const event = await lastData("openai-chat")
    expect(event).toMatchObject({ error: { router: { wall: "capacity", retryable: true } } })
  })

  test("openai-responses: router beside code and message", async () => {
    const event = await lastData("openai-responses")
    expect(event).toMatchObject({ type: "error", router: { wall: "capacity", retryable: true } })
  })
})
