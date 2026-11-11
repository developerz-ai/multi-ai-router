import { describe, expect, test } from "bun:test"
import { coerceForcedToolResponse } from "../../../src/services/dataplane/forced-tool-coercion"

/**
 * Plan 101, 02.4 (ruled yes): a forced-tool stream is held only until its first content block. A
 * vendor that obeyed (`tool_use`) reaches the client before the upstream ends; one that answered in
 * text is still read whole and coerced, byte-identically to before.
 */

const event = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...(data as object) })}\n\n`
const START = event("message_start", { message: { id: "msg_1", model: "m", usage: {} } })
const STOP =
  event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }) +
  event("message_stop", {})

/** An upstream that sends `head`, then waits for `release` before sending `tail` and closing. */
function slowUpstream(head: string, tail: string) {
  const release = Promise.withResolvers<void>()
  let ended = false
  const encoder = new TextEncoder()
  let step = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step++ === 0) {
        controller.enqueue(encoder.encode(head))
        return
      }
      await release.promise
      controller.enqueue(encoder.encode(tail))
      ended = true
      controller.close()
    },
  })
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    release: () => release.resolve(),
    ended: () => ended,
  }
}

describe("forced-tool streams", () => {
  test("a stream that starts with tool_use reaches the client before the upstream ends", async () => {
    const head =
      START +
      event("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "json", input: {} },
      })
    const upstream = slowUpstream(head, STOP)
    let coerced = 0
    const relayed = coerceForcedToolResponse(upstream.response, "json", () => coerced++)
    const reader = relayed.body?.getReader()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toBe(head)
    expect(upstream.ended()).toBe(false)
    upstream.release()
    let rest = ""
    for (;;) {
      const next = await reader?.read()
      if (next === undefined || next.done) break
      rest += new TextDecoder().decode(next.value)
    }
    expect(rest).toBe(STOP)
    expect(coerced).toBe(0)
  })

  test("a text-first stream is still read whole and coerced", async () => {
    const head =
      START + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    const tail =
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: '{"a":1}' },
      }) +
      event("content_block_stop", { index: 0 }) +
      STOP
    const upstream = slowUpstream(head, tail)
    let coerced = 0
    const relayed = coerceForcedToolResponse(
      upstream.response,
      "json",
      () => coerced++,
      undefined,
      () => "toolu_fixed",
    )
    const reading = relayed.text()
    upstream.release()
    const text = await reading
    expect(coerced).toBe(1)
    expect(text).toContain('"type":"tool_use"')
    expect(text).toContain("toolu_fixed")
  })

  test("past the buffered-read ceiling the stream is relayed as it came", async () => {
    const head =
      START + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    const upstream = slowUpstream(head, STOP)
    const relayed = coerceForcedToolResponse(
      upstream.response,
      "json",
      () => {},
      undefined,
      undefined,
      16,
    )
    const reading = relayed.text()
    upstream.release()
    expect(await reading).toBe(head + STOP)
  })
})
