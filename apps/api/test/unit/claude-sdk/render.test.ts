import { describe, expect, test } from "bun:test"
import { renderSdkResponse } from "../../../src/providers"
import { sdkQueryStream, sdkTurn, wireEvent } from "./fixtures"

/**
 * `renderSdkResponse` driven end to end by a `query()`-shaped stream — `system(init)` →
 * `stream_event`* → `rate_limit_event` → `result` — rather than by pushing pre-parsed wire events
 * straight at the envelope the way `test/unit/providers/sdk-render.test.ts` does.
 *
 * That file and `sdk-stream.test.ts` already pin every edge of the three narrowings (the block
 * index map, the envelope funnel, the idle guard). This one exists for a property none of them
 * state at the *pipeline* level: what a client actually receives when a real agent loop — two full
 * internal turns, one of them a subagent's — is read the way the SDK really emits it
 * (docs/idea/11-anthropic-agent-sdk.md §6).
 */

function events(sse: string): { readonly name: string; readonly data: Record<string, unknown> }[] {
  return sse
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const [name = "", data = ""] = block.split("\n")
      return { name: name.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) }
    })
}

const TEXT_BLOCK = [
  { type: "text", text: "" },
  { type: "text_delta", text: "hi" },
] as const

describe("rendering two internal turns", () => {
  test("exactly one message_start and one message_stop reach the client", async () => {
    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [
          sdkTurn({ blocks: [TEXT_BLOCK], stopReason: "tool_use" }),
          sdkTurn({ blocks: [TEXT_BLOCK], stopReason: "end_turn" }),
        ],
        rateLimitInfo: { status: "allowed" },
        result: { stop_reason: "end_turn", usage: { output_tokens: 9 } },
      }),
      model: "claude-sonnet-4-5",
      stream: true,
    })

    const frames = events(await response.text())
    const names = frames.map((frame) => frame.name)

    expect(names.filter((name) => name === "message_start")).toHaveLength(1)
    expect(names.filter((name) => name === "message_stop")).toHaveLength(1)
    expect(names.at(0)).toBe("message_start")
    expect(names.at(-1)).toBe("message_stop")
    // Both turns' own message_delta/message_stop are swallowed — only the terminal one survives.
    expect(names.filter((name) => name === "message_delta")).toHaveLength(1)
  })

  test("block indices are monotonic across the turn boundary, never restarting at zero", async () => {
    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [
          sdkTurn({ blocks: [TEXT_BLOCK, TEXT_BLOCK] }),
          // The SDK numbers this turn's blocks from zero again — the client must not see that.
          sdkTurn({ blocks: [TEXT_BLOCK] }),
        ],
      }),
      model: "claude-sonnet-4-5",
      stream: true,
    })

    const frames = events(await response.text())
    const opened = frames.filter((frame) => frame.name === "content_block_start")

    expect(opened.map((frame) => frame.data.index)).toEqual([0, 1, 2])
  })

  test("a subagent turn is filtered whole: its start, delta, and stop all drop", async () => {
    const subagentTurn = sdkTurn({ blocks: [TEXT_BLOCK], parentToolUseId: "toolu_task" })

    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [sdkTurn({ blocks: [TEXT_BLOCK] }), subagentTurn],
      }),
      model: "claude-sonnet-4-5",
      stream: true,
    })

    const frames = events(await response.text())
    const blockFrames = frames.filter((frame) => frame.name.startsWith("content_block"))

    // Only the main turn's one block reached the client — the subagent's triple is gone entirely,
    // not just its start.
    expect(blockFrames).toHaveLength(3)
    expect(blockFrames.every((frame) => frame.data.index === 0)).toBe(true)
  })

  test("the non-streaming fold sees the identical sequence, one message with both turns' text", async () => {
    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [sdkTurn({ blocks: [TEXT_BLOCK] }), sdkTurn({ blocks: [TEXT_BLOCK] })],
        result: { stop_reason: "end_turn" },
      }),
      model: "claude-sonnet-4-5",
      stream: false,
    })

    const body = (await response.json()) as { content: readonly { text: string }[] }
    expect(body.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "hi" },
    ])
  })

  test("the rate-limit event mid-stream never reaches the client", async () => {
    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [sdkTurn({ blocks: [TEXT_BLOCK] })],
        rateLimitInfo: { status: "rejected", rateLimitType: "five_hour" },
      }),
      model: "claude-sonnet-4-5",
      stream: true,
    })

    const body = await response.text()
    expect(body).not.toContain("rate_limit")
    expect(body).not.toContain("five_hour")
  })
})

describe("a stream that loses a content_block_stop", () => {
  test("the client's transcript is repaired and the observer is alarmed, once", async () => {
    const counts: number[] = []
    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [
          [
            wireEvent({
              type: "message_start",
              message: { id: "msg_1", type: "message", role: "assistant", content: [] },
            }),
            wireEvent({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
            wireEvent({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hi" },
            }),
            // No content_block_stop: the regression this alarm exists for.
            wireEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
            wireEvent({ type: "message_stop" }),
          ],
        ],
        result: { stop_reason: "end_turn" },
      }),
      model: "claude-sonnet-4-5",
      stream: true,
      observer: { onForcedBlockClose: (count) => counts.push(count) },
    })

    const names = events(await response.text()).map((frame) => frame.name)
    // The client still gets a sound sequence — the force-close is the repair…
    expect(names).toContain("content_block_stop")
    expect(names.at(-1)).toBe("message_stop")
    // …and the counter is the alarm, which used to exist only in user transcripts.
    expect(counts).toEqual([1])
  })

  test("a clean stream never calls the alarm", async () => {
    const counts: number[] = []
    const response = await renderSdkResponse({
      messages: sdkQueryStream({ turns: [sdkTurn({ blocks: [TEXT_BLOCK] })] }),
      model: "claude-sonnet-4-5",
      stream: true,
      observer: { onForcedBlockClose: (count) => counts.push(count) },
    })

    await response.text()
    expect(counts).toEqual([])
  })
})

describe("a fixture body that never opens a block", () => {
  test("a tool-only turn still funnels through message_start/message_stop cleanly", async () => {
    const response = await renderSdkResponse({
      messages: sdkQueryStream({
        turns: [
          [
            wireEvent({
              type: "message_start",
              message: { id: "msg_1", type: "message", role: "assistant", content: [] },
            }),
            wireEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
            wireEvent({ type: "message_stop" }),
          ],
        ],
        result: { stop_reason: "tool_use" },
      }),
      model: "claude-sonnet-4-5",
      stream: true,
    })

    const names = events(await response.text()).map((frame) => frame.name)
    expect(names).toEqual(["message_start", "message_delta", "message_stop"])
  })
})
