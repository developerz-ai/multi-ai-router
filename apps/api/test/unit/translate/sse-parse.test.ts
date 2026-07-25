/**
 * The incremental SSE frame reader — the only SSE parser in the repo.
 *
 * The point of every test here is the same: a chunk is not an event. A provider may split a frame
 * anywhere, including down the middle of a `\r\n`, and a frame must still be returned the instant
 * its terminating blank line arrives.
 */

import { describe, expect, test } from "bun:test"
import { createSseParser, encodeSseEvent, frameJson } from "../../../src/services/translate"

const encoder = new TextEncoder()

/** One byte at a time: the worst chunking an upstream can inflict. */
function pushByByte(text: string): { event: string | null; data: string }[] {
  const parser = createSseParser()
  const frames: { event: string | null; data: string }[] = []
  for (const byte of encoder.encode(text)) frames.push(...parser.push(new Uint8Array([byte])))
  frames.push(...parser.flush())
  return frames
}

describe("frame boundaries", () => {
  test("a complete frame is returned as soon as its blank line arrives", () => {
    const parser = createSseParser()
    expect(parser.push('event: ping\ndata: {"type":"ping"}\n\n')).toEqual([
      { event: "ping", data: '{"type":"ping"}' },
    ])
  })

  test("a frame split across chunks is carried, then emitted whole", () => {
    const parser = createSseParser()
    expect(parser.push("event: content_block_de")).toEqual([])
    expect(parser.push('lta\ndata: {"index":0,"te')).toEqual([])
    expect(parser.push('xt":"hi"}\n')).toEqual([])
    expect(parser.push("\n")).toEqual([
      { event: "content_block_delta", data: '{"index":0,"text":"hi"}' },
    ])
  })

  test("one chunk carrying several frames returns all of them, in order", () => {
    const parser = createSseParser()
    const frames = parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n")
    expect(frames.map((frame) => frame.event)).toEqual(["a", "b", "c"])
    expect(frames.map((frame) => frame.data)).toEqual(["1", "2", "3"])
  })

  test("byte-at-a-time delivery yields exactly the same frames as one big chunk", () => {
    const text = 'event: message_start\ndata: {"type":"message_start"}\n\ndata: tail\n\n'
    expect(pushByByte(text)).toEqual([
      { event: "message_start", data: '{"type":"message_start"}' },
      { event: null, data: "tail" },
    ])
  })
})

describe("the line grammar", () => {
  test("CRLF, LF, and a bare CR all end a line", () => {
    const parser = createSseParser()
    expect(parser.push("data: a\r\n\r\n")).toEqual([{ event: null, data: "a" }])
    expect(parser.push("data: b\n\n")).toEqual([{ event: null, data: "b" }])
    expect(parser.push("data: c\r\r")).toEqual([{ event: null, data: "c" }])
  })

  test("a CRLF split across the chunk boundary is one terminator, not two", () => {
    const parser = createSseParser()
    expect(parser.push("data: a\r")).toEqual([])
    // The `\n` belongs to the CR already consumed; treating it as a line would dispatch early.
    expect(parser.push("\ndata: b\n\n")).toEqual([{ event: null, data: "a\nb" }])
  })

  test("repeated data lines join with a newline", () => {
    const parser = createSseParser()
    expect(parser.push("data: one\ndata: two\ndata: three\n\n")).toEqual([
      { event: null, data: "one\ntwo\nthree" },
    ])
  })

  test("exactly one leading space after the colon is stripped", () => {
    const parser = createSseParser()
    expect(parser.push("data:  padded\n\n")).toEqual([{ event: null, data: " padded" }])
  })

  test("a field with no colon at all is read as an empty value", () => {
    const parser = createSseParser()
    expect(parser.push("data\ndata: real\n\n")).toEqual([{ event: null, data: "\nreal" }])
  })

  test("a comment line is a keepalive and produces nothing", () => {
    const parser = createSseParser()
    expect(parser.push(": ping\n\n")).toEqual([])
    expect(parser.push("data: after\n\n")).toEqual([{ event: null, data: "after" }])
  })

  test("`id` and `retry` are recognized and ignored, never read as data", () => {
    const parser = createSseParser()
    expect(parser.push("id: 42\nretry: 3000\ndata: payload\n\n")).toEqual([
      { event: null, data: "payload" },
    ])
  })

  test("a leading BOM is stripped once, not treated as part of the first field name", () => {
    const parser = createSseParser()
    expect(parser.push("﻿data: first\n\n")).toEqual([{ event: null, data: "first" }])
  })

  test("a frame carrying no data line at all dispatches nothing", () => {
    const parser = createSseParser()
    expect(parser.push("event: lonely\n\n")).toEqual([])
    // …and the orphaned event name does not leak onto the next frame.
    expect(parser.push("data: next\n\n")).toEqual([{ event: null, data: "next" }])
  })

  test("an empty data value is a real frame — absence is the empty line, not an empty value", () => {
    const parser = createSseParser()
    expect(parser.push("data:\n\n")).toEqual([{ event: null, data: "" }])
  })
})

describe("stream end", () => {
  test("flush emits a trailing frame the upstream never terminated", () => {
    const parser = createSseParser()
    expect(parser.push("data: [DONE]\n")).toEqual([])
    expect(parser.flush()).toEqual([{ event: null, data: "[DONE]" }])
  })

  test("flush emits a frame whose last line has no terminator either", () => {
    const parser = createSseParser()
    expect(parser.push("event: message_stop\ndata: {}")).toEqual([])
    expect(parser.flush()).toEqual([{ event: "message_stop", data: "{}" }])
  })

  test("flush on an exhausted parser emits nothing", () => {
    const parser = createSseParser()
    parser.push("data: a\n\n")
    expect(parser.flush()).toEqual([])
  })

  test("a multi-byte character split across chunks survives", () => {
    const parser = createSseParser()
    const bytes = encoder.encode("data: ✓\n\n")
    expect(parser.push(bytes.slice(0, 7))).toEqual([])
    expect(parser.push(bytes.slice(7))).toEqual([{ event: null, data: "✓" }])
  })
})

describe("payload decoding", () => {
  test("frameJson decodes a JSON payload", () => {
    expect(frameJson({ event: null, data: '{"a":1}' })).toEqual({ a: 1 })
  })

  test("frameJson returns null for the `[DONE]` sentinel and for a malformed payload", () => {
    expect(frameJson({ event: null, data: "[DONE]" })).toBeNull()
    expect(frameJson({ event: null, data: "{not json" })).toBeNull()
  })
})

describe("the encoder", () => {
  test("a named event renders both lines and the terminating blank line", () => {
    expect(encodeSseEvent({ event: "message_stop", data: '{"type":"message_stop"}' })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    )
  })

  test("an unnamed event renders data only — openai-chat never sets `event:`", () => {
    expect(encodeSseEvent({ data: "[DONE]" })).toBe("data: [DONE]\n\n")
  })

  test("a multi-line payload becomes one data line per line, and round-trips", () => {
    const encoded = encodeSseEvent({ event: "x", data: "one\ntwo" })
    expect(encoded).toBe("event: x\ndata: one\ndata: two\n\n")
    expect(createSseParser().push(encoded)).toEqual([{ event: "x", data: "one\ntwo" }])
  })
})
