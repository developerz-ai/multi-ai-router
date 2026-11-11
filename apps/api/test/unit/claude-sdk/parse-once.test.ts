import { describe, expect, test } from "bun:test"
import { readSdkMessage, readWireEvent } from "../../../src/providers/claude-sdk/render/events"

/**
 * 101 finding 05.10: one SDK chunk was `safeParse`d three to five times on its way through the
 * early stop, the liveness check and the renderer. Each view is now parsed once per chunk object:
 * a second read hands back the very same view, which is what proves no second parse ran.
 */
describe("an SDK chunk is parsed once", () => {
  test("readSdkMessage and readWireEvent return the remembered view for the same object", () => {
    const chunk = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    }
    const message = readSdkMessage(chunk)
    expect(message).not.toBeNull()
    expect(readSdkMessage(chunk)).toBe(message)
    const event = readWireEvent(message?.event)
    expect(event?.type).toBe("content_block_delta")
    expect(readWireEvent(chunk.event)).toBe(event)
  })

  test("a different object is parsed on its own, and a non-object is never remembered", () => {
    const a = { type: "keep_alive" }
    const b = { type: "keep_alive" }
    expect(readSdkMessage(a)).not.toBe(readSdkMessage(b))
    expect(readSdkMessage("not a message")).toBeNull()
    expect(readWireEvent(null)).toBeNull()
  })
})
