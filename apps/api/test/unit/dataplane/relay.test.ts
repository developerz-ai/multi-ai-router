import { describe, expect, test } from "bun:test"
import { relayResponse } from "../../../src/services/dataplane"
import { slowStream } from "./fixtures"

/**
 * **Never buffer a stream.** This is the hard requirement, so it is asserted against a deliberately
 * slow upstream rather than inferred from the code: a chunk the upstream has produced must be
 * readable by the client *before* the upstream produces the next one, and long before it closes.
 *
 * A relay that accumulated — or that waited for a complete SSE event before flushing — would hang
 * these tests at the first read.
 */

const decoder = new TextDecoder()

async function readOne(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read()
  if (done || value === undefined) throw new Error("stream ended early")
  return decoder.decode(value)
}

describe("stream relay", () => {
  test("hands each chunk to the client before the upstream sends the next", async () => {
    const upstream = slowStream([
      "event: message_start\ndata: {}\n\n",
      "event: content_block_delta\ndata: {}\n\n",
      "event: message_stop\ndata: {}\n\n",
    ])
    const relayed = relayResponse(upstream.response)
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()

    upstream.release(0)
    expect(await readOne(reader)).toContain("message_start")

    // The upstream has sent exactly one chunk and has not closed. If the relay were buffering,
    // the read above would still be pending.
    upstream.release(1)
    expect(await readOne(reader)).toContain("content_block_delta")

    upstream.release(2)
    expect(await readOne(reader)).toContain("message_stop")

    upstream.finish()
    expect((await reader.read()).done).toBe(true)
  })

  test("does not re-chunk: the client reads the boundaries the upstream produced", async () => {
    const upstream = slowStream(["alpha", "beta", "gamma"])
    const relayed = relayResponse(upstream.response)
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()

    upstream.release(0)
    upstream.release(1)
    upstream.release(2)

    expect(await readOne(reader)).toBe("alpha")
    expect(await readOne(reader)).toBe("beta")
    expect(await readOne(reader)).toBe("gamma")
  })

  test("observation never sits between a byte and the client", async () => {
    const seen: string[] = []
    const upstream = slowStream(["one", "two"])
    const relayed = relayResponse(upstream.response, {
      onChunk: (chunk) => seen.push(decoder.decode(chunk)),
    })
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()

    upstream.release(0)
    expect(await readOne(reader)).toBe("one")
    expect(seen).toEqual(["one"])
  })

  test("a throwing observer degrades reporting, never the stream", async () => {
    const upstream = slowStream(["one"])
    const relayed = relayResponse(upstream.response, {
      onChunk: () => {
        throw new Error("observer exploded")
      },
    })
    if (relayed.body === null) throw new Error("expected a body")
    const reader = relayed.body.getReader()

    upstream.release(0)
    expect(await readOne(reader)).toBe("one")
  })

  test("reports the end once, with the byte count", async () => {
    const upstream = slowStream(["abc", "de"])
    let ended: number | null = null
    const relayed = relayResponse(upstream.response, {
      onEnd: (bytes) => {
        ended = bytes
      },
    })
    if (relayed.body === null) throw new Error("expected a body")

    upstream.release(0)
    upstream.release(1)
    upstream.finish()
    await relayed.text()

    expect(ended).toBe(5)
  })

  test("relays the status and the response headers", async () => {
    const upstream = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "x-custom": "kept" },
    })
    const relayed = relayResponse(upstream)

    expect(relayed.status).toBe(200)
    expect(relayed.headers.get("x-custom")).toBe("kept")
    expect(await relayed.text()).toBe("{}")
  })
})
