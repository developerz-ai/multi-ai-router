import { describe, expect, test } from "bun:test"
import { createEnvelope } from "../../../src/providers/claude-sdk/render/envelope"
import { readSdkMessage, readWireEvent } from "../../../src/providers/claude-sdk/render/events"
import { createBlockIndexMap } from "../../../src/providers/claude-sdk/render/index-map"
import { createMessageFold } from "../../../src/providers/claude-sdk/render/message"

/**
 * The three narrowings that turn an SDK agent loop into one Anthropic message
 * (docs/idea/11-anthropic-agent-sdk.md §6).
 *
 * Every case here is a fixture in and a frame sequence out — no clock, no stream plumbing, no
 * subprocess. That is possible because the pieces are pure, and it is the reason they were split
 * this way: the index remap, the envelope funnel, and the non-streaming fold each fail differently,
 * and a test that drove all three through a `ReadableStream` could not say which one broke.
 */

const MODEL = "claude-sonnet-4-5"

function envelope(newId = () => "msg_fixed") {
  return createEnvelope({ model: MODEL, newId })
}

/** A raw Anthropic wire event, as the SDK carries it in `stream_event.event`. */
function wire(event: Record<string, unknown>) {
  const parsed = readWireEvent(event)
  if (parsed === null) throw new Error("fixture is not a wire event")
  return parsed
}

const START = {
  type: "message_start",
  message: { id: "msg_upstream", type: "message", role: "assistant", model: MODEL, content: [] },
}

function textBlock(index: number) {
  return { type: "content_block_start", index, content_block: { type: "text", text: "" } }
}

function textDelta(index: number, text: string) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } }
}

function push(
  env: ReturnType<typeof envelope>,
  events: readonly Record<string, unknown>[],
  turn: string | null = null,
) {
  const frames = []
  for (const event of events) frames.push(...env.push(wire(event), turn))
  return frames
}

describe("the SDK→client block index map", () => {
  test("restarts by the SDK are renumbered monotonically for the client", () => {
    const map = createBlockIndexMap()

    // Internal turn one.
    expect(map.start(null, 0, true)).toEqual({ kind: "forward", index: 0 })
    expect(map.start(null, 1, true)).toEqual({ kind: "forward", index: 1 })
    expect(map.stop(null, 0)).toEqual({ kind: "forward", index: 0 })
    expect(map.stop(null, 1)).toEqual({ kind: "forward", index: 1 })

    // Internal turn two starts at zero again. The client must not see index 0 twice.
    expect(map.start(null, 0, true)).toEqual({ kind: "forward", index: 2 })
    expect(map.block(null, 0)).toEqual({ kind: "forward", index: 2 })
    expect(map.allocated).toBe(3)
  })

  test("a filtered block loses its delta and its stop, not only its start", () => {
    const map = createBlockIndexMap()

    expect(map.start(null, 0, false)).toEqual({ kind: "drop" })
    expect(map.block(null, 0)).toEqual({ kind: "drop" })
    expect(map.stop(null, 0)).toEqual({ kind: "drop" })
    // And it consumed no client index, so the next kept block is still zero.
    expect(map.start(null, 1, true)).toEqual({ kind: "forward", index: 0 })
  })

  test("two turns using the same index never share a mapping", () => {
    const map = createBlockIndexMap()

    expect(map.start(null, 0, true)).toEqual({ kind: "forward", index: 0 })
    // A subagent's block 0 is dropped, and dropping it must not evict the answer's block 0.
    expect(map.start("toolu_task", 0, false)).toEqual({ kind: "drop" })
    expect(map.block("toolu_task", 0)).toEqual({ kind: "drop" })
    expect(map.block(null, 0)).toEqual({ kind: "forward", index: 0 })
  })

  test("a delta for a block that never started is dropped", () => {
    const map = createBlockIndexMap()
    expect(map.block(null, 7)).toEqual({ kind: "drop" })
    expect(map.stop(null, 7)).toEqual({ kind: "drop" })
  })

  test("open indices are reported until they stop, so a terminating stream can close them", () => {
    const map = createBlockIndexMap()
    map.start(null, 0, true)
    map.start(null, 1, true)
    expect(map.open()).toEqual([0, 1])
    map.stop(null, 0)
    expect(map.open()).toEqual([1])
  })
})

describe("the message envelope", () => {
  test("emits exactly one message_start and one message_stop across several internal turns", () => {
    const env = envelope()
    const frames = push(env, [
      START,
      textBlock(0),
      textDelta(0, "one"),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
      // Turn two: its own start, its own numbering.
      START,
      textBlock(0),
      textDelta(0, "two"),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ])
    frames.push(...env.finish({ stopReason: null, usage: { output_tokens: 9 } }))

    const types = frames.map((frame) => frame.type)
    expect(types.filter((type) => type === "message_start")).toHaveLength(1)
    expect(types.filter((type) => type === "message_stop")).toHaveLength(1)
    expect(types.filter((type) => type === "message_delta")).toHaveLength(1)
    expect(types.at(-1)).toBe("message_stop")

    // Turn two's blocks were renumbered rather than overwriting turn one's.
    const opened = frames.filter((frame) => frame.type === "content_block_start")
    expect(opened.map((frame) => frame.index)).toEqual([0, 1])
  })

  test("the terminal message_delta states the last stop reason and the authoritative usage", () => {
    const env = envelope()
    push(env, [
      START,
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
    ])
    const [delta] = env.finish({
      stopReason: null,
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 33,
      },
    })

    expect(delta).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      // A count nobody measured is absent, never a zero: no `cache_creation_input_tokens` here.
      usage: { output_tokens: 22, input_tokens: 11, cache_read_input_tokens: 33 },
    })
  })

  test("a caller-stated stop reason wins over the one an internal turn reported", () => {
    const env = envelope()
    push(env, [START, { type: "message_delta", delta: { stop_reason: "tool_use" } }])
    const frames = env.finish({ stopReason: "max_tokens", usage: null })
    expect(frames[0]?.delta).toEqual({ stop_reason: "max_tokens", stop_sequence: null })
  })

  test("a turn nobody stated a reason for reports absence rather than inventing end_turn", () => {
    const env = envelope()
    push(env, [START])
    const frames = env.finish({ stopReason: null, usage: null })
    expect(frames[0]?.delta).toEqual({ stop_reason: null, stop_sequence: null })
  })

  test("an empty completion is empty — never a fabricated sentence", () => {
    const env = envelope()
    const frames = env.finish({ stopReason: "end_turn", usage: null })

    expect(frames.map((frame) => frame.type)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ])
    expect(frames[0]?.message).toMatchObject({ id: "msg_fixed", model: MODEL, content: [] })
  })

  test("a synthesized id is CSPRNG-backed, never derived from the clock", () => {
    const first = createEnvelope({ model: MODEL }).finish({ stopReason: null, usage: null })
    const second = createEnvelope({ model: MODEL }).finish({ stopReason: null, usage: null })
    const idOf = (frames: readonly { readonly message?: unknown }[]): string => {
      const message = frames[0]?.message
      return typeof message === "object" && message !== null && "id" in message
        ? String((message as { id: unknown }).id)
        : ""
    }

    expect(idOf(first)).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(idOf(first)).not.toBe(idOf(second))
  })

  test("the upstream's own id and model are forwarded when it named them", () => {
    const env = envelope()
    const [start] = push(env, [START])
    expect(start?.message).toMatchObject({ id: "msg_upstream", model: MODEL })
  })

  test("a block arriving before any message_start still gets one", () => {
    const env = envelope()
    const frames = push(env, [textBlock(0)])
    expect(frames.map((frame) => frame.type)).toEqual(["message_start", "content_block_start"])
  })

  test("an open block is closed before the terminal frames", () => {
    const env = envelope()
    push(env, [START, textBlock(0), textDelta(0, "unterminated")])
    const frames = env.finish({ stopReason: "end_turn", usage: null })
    expect(frames.map((frame) => frame.type)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(frames[0]?.index).toBe(0)
  })

  test("a subagent's turn never reaches the client, triple included", () => {
    const env = envelope()
    const frames = [
      ...env.push(wire(START), null),
      ...env.push(wire(textBlock(0)), null),
      // The subagent numbers its own blocks from zero, exactly as the main turn does.
      ...env.push(wire(textBlock(0)), "toolu_task"),
      ...env.push(wire(textDelta(0, "subagent")), "toolu_task"),
      ...env.push(wire({ type: "content_block_stop", index: 0 }), "toolu_task"),
      ...env.push(wire(textDelta(0, "answer")), null),
    ]

    expect(frames.map((frame) => frame.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ])
    expect(frames.at(-1)?.delta).toEqual({ type: "text_delta", text: "answer" })
  })

  test("an upstream error is forwarded verbatim and is terminal", () => {
    const env = envelope()
    push(env, [START])
    const failure = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
    const frames = push(env, [failure])

    expect(frames).toEqual([failure])
    expect(env.terminated).toBe(true)
    expect(env.finish({ stopReason: "end_turn", usage: null })).toEqual([])
    expect(push(env, [textBlock(0)])).toEqual([])
  })

  test("fail() spells a post-first-byte failure as one terminal error frame", () => {
    const env = envelope()
    push(env, [START])
    expect(env.fail("api_error", "stalled")).toEqual([
      { type: "error", error: { type: "api_error", message: "stalled" } },
    ])
    expect(env.fail("api_error", "again")).toEqual([])
  })

  test("an event type this build does not define is dropped rather than guessed at", () => {
    const env = envelope()
    expect(push(env, [{ type: "some_future_event", index: 0 }])).toEqual([])
  })

  test("a block event with no index is unusable and is dropped", () => {
    const env = envelope()
    expect(push(env, [{ type: "content_block_start", content_block: { type: "text" } }])).toEqual(
      [],
    )
  })
})

describe("the non-streaming fold", () => {
  test("assembles the same message a streaming client would have", () => {
    const env = envelope()
    const fold = createMessageFold()
    fold.push(
      push(env, [
        START,
        textBlock(0),
        textDelta(0, "Hel"),
        textDelta(0, "lo"),
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
        },
        { type: "content_block_stop", index: 1 },
      ]),
    )
    fold.push(env.finish({ stopReason: "tool_use", usage: { output_tokens: 12 } }))

    expect(fold.body()).toEqual({
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { output_tokens: 12 },
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
      ],
    })
  })

  test("thinking deltas and their signature survive the fold", () => {
    const env = envelope()
    const fold = createMessageFold()
    fold.push(
      push(env, [
        START,
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hm" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
        { type: "content_block_stop", index: 0 },
      ]),
    )
    fold.push(env.finish({ stopReason: "end_turn", usage: null }))

    expect(fold.body().content).toEqual([{ type: "thinking", thinking: "hm", signature: "sig" }])
  })

  test("a truncated tool call keeps its stated input rather than reporting an empty one", () => {
    const env = envelope()
    const fold = createMessageFold()
    fold.push(
      push(env, [
        START,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"pa' },
        },
        { type: "content_block_stop", index: 0 },
      ]),
    )
    fold.push(env.finish({ stopReason: "tool_use", usage: null }))

    expect(fold.body().content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
    ])
  })

  test("an empty turn folds to an empty content array", () => {
    const env = envelope()
    const fold = createMessageFold()
    fold.push(env.finish({ stopReason: "end_turn", usage: null }))
    expect(fold.body()).toMatchObject({ content: [], stop_reason: "end_turn" })
  })

  test("an error frame yields the error object rather than a message", () => {
    const fold = createMessageFold()
    fold.push([{ type: "error", error: { type: "api_error", message: "stalled" } }])
    expect(fold.body()).toEqual({ type: "error", error: { type: "api_error", message: "stalled" } })
  })
})

describe("reading what the subprocess said", () => {
  test("a message that is not an SDK message at all is skipped, never thrown on", () => {
    expect(readSdkMessage(null)).toBeNull()
    expect(readSdkMessage({ noType: true })).toBeNull()
    expect(readWireEvent("not an object")).toBeNull()
  })

  test("a subagent's message is identifiable by its parent tool use id", () => {
    expect(readSdkMessage({ type: "stream_event", parent_tool_use_id: "toolu_1" })).toMatchObject({
      parentToolUseId: "toolu_1",
    })
    expect(readSdkMessage({ type: "stream_event" })).toMatchObject({ parentToolUseId: null })
  })

  test("a malformed usage field is absent rather than zeroed", () => {
    const message = readSdkMessage({ type: "result", usage: { output_tokens: "twelve" } })
    expect(message?.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    })
  })

  test("fields this build has never heard of survive the parse", () => {
    const event = readWireEvent({ type: "content_block_delta", index: 3, brand_new: { a: 1 } })
    expect(event?.raw).toMatchObject({ brand_new: { a: 1 } })
    expect(event?.index).toBe(3)
  })
})

describe("usage split across the SDK's events", () => {
  /** The real shape: `message_start` carries input+cache, each `message_delta` the output so far. */
  const START_WITH_USAGE = {
    type: "message_start",
    message: {
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      usage: {
        input_tokens: 1200,
        output_tokens: 1,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4500,
      },
    },
  }

  test("a turn with no authoritative result still bills input and cache, not output alone", () => {
    const env = envelope()
    push(env, [
      START_WITH_USAGE,
      textBlock(0),
      textDelta(0, "calling a tool"),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    ])

    // The early-stopped tool-call loop synthesizes a result with **no** usage on purpose
    // (`tools/early-stop.ts`), so the completion arrives null — the dominant agent-traffic shape,
    // and the one that used to lose every input and cache count it had already been told.
    const [delta] = env.finish({ stopReason: "tool_use", usage: null })

    expect(delta?.usage).toEqual({
      output_tokens: 42,
      input_tokens: 1200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 4500,
    })
  })

  test("a count nobody measured stays absent — merging never zero-fills", () => {
    const env = envelope()
    push(env, [
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          content: [],
          usage: { input_tokens: 7 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    ])
    const [delta] = env.finish({ stopReason: null, usage: null })

    expect(delta?.usage).toEqual({ output_tokens: 3, input_tokens: 7 })
  })

  test("a subagent's message_start never bills the main turn", () => {
    const env = envelope()
    env.push(wire(START), null)
    env.push(wire(START_WITH_USAGE), "toolu_task")
    const [delta] = env.finish({ stopReason: null, usage: null })

    expect(delta?.usage).toEqual({ output_tokens: 0 })
  })

  test("the authoritative result usage still wins wholesale when it exists", () => {
    const env = envelope()
    push(env, [
      START_WITH_USAGE,
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
    ])
    const [delta] = env.finish({
      stopReason: "end_turn",
      usage: {
        input_tokens: 9,
        output_tokens: 10,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    })

    expect(delta?.usage).toEqual({ output_tokens: 10, input_tokens: 9 })
  })
})

describe("context_management never reaches a client", () => {
  /**
   * The SDK/CLI attaches `context_management` to streamed events; the real Anthropic API never
   * emits it on a plain request, and stock clients crash calling into it as if it were typed
   * (observed against langchain-anthropic — Meridian #525). Stripped at the envelope, both levels.
   */
  test("stripped from the event and from event.delta, everything else intact", () => {
    const env = envelope()
    const [start] = push(env, [{ ...START, context_management: { applied_edits: [] } }])
    expect(start).not.toHaveProperty("context_management")
    expect(start?.message).toMatchObject({ id: "msg_upstream", model: MODEL })

    const frames = push(env, [
      textBlock(0),
      {
        type: "content_block_delta",
        index: 0,
        context_management: { applied_edits: [] },
        delta: { type: "text_delta", text: "hi", context_management: { applied_edits: [] } },
      },
    ])
    const delta = frames.at(-1)

    expect(delta).not.toHaveProperty("context_management")
    expect(delta?.delta).toEqual({ type: "text_delta", text: "hi" })
    expect(delta?.index).toBe(0)
    expect(delta?.type).toBe("content_block_delta")
  })

  test("a frame without the field is passed through untouched, not rebuilt", () => {
    const env = envelope()
    push(env, [START])
    const frames = push(env, [textBlock(0), textDelta(0, "verbatim")])
    expect(frames.at(-1)?.delta).toEqual({ type: "text_delta", text: "verbatim" })
  })
})

describe("dangling blocks are an alarm, not only a repair", () => {
  test("finish counts the blocks it had to force-close", () => {
    const env = envelope()
    push(env, [START, textBlock(0), textDelta(0, "unterminated"), textBlock(1)])
    expect(env.forcedBlockCloses).toBe(0)

    const frames = env.finish({ stopReason: null, usage: null })
    expect(env.forcedBlockCloses).toBe(2)
    expect(frames.filter((frame) => frame.type === "content_block_stop")).toHaveLength(2)
  })

  test("a clean turn counts zero", () => {
    const env = envelope()
    push(env, [START, textBlock(0), textDelta(0, "hi"), { type: "content_block_stop", index: 0 }])
    env.finish({ stopReason: "end_turn", usage: null })
    expect(env.forcedBlockCloses).toBe(0)
  })
})

describe("unknown delta kinds fold the same as they stream", () => {
  test("the payload lands on the block verbatim, newest value winning", () => {
    // The streaming half forwards a future delta kind untouched (`envelope.ts`); the fold used to
    // drop it, so `stream: true` and `stream: false` diverged for every block type Anthropic adds.
    const fold = createMessageFold()
    fold.push([
      { type: "message_start", message: { id: "m", type: "message", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "future_block" } },
      { type: "content_block_delta", index: 0, delta: { type: "future_delta", payload: "one" } },
      { type: "content_block_delta", index: 0, delta: { type: "future_delta", payload: "two" } },
      { type: "content_block_stop", index: 0 },
    ])

    expect(fold.body().content).toEqual([{ type: "future_block", payload: "two" }])
  })

  test("the known kinds keep their accumulate semantics", () => {
    const fold = createMessageFold()
    fold.push([
      { type: "message_start", message: { id: "m", type: "message", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } },
      { type: "content_block_stop", index: 0 },
    ])
    expect(fold.body().content).toEqual([{ type: "text", text: "ab" }])
  })
})
