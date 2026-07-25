import { describe, expect, test } from "bun:test"
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { renderSdkResponse } from "../../../src/providers/claude-sdk/render/stream"
import { qualifyToolName } from "../../../src/providers/claude-sdk/tools/names"
import {
  createPassthrough,
  type DeclaredTool,
  type Passthrough,
} from "../../../src/providers/claude-sdk/tools/register"

/**
 * The stream half of tool passthrough: what the client is handed, and how a turn that asked for a
 * tool is brought to an end (docs/idea/11-anthropic-agent-sdk.md §7).
 *
 * Four properties, and each one is a bug that is otherwise silent:
 *
 * - the client gets **its own** tool name and **its own** argument spelling back;
 * - a denied call does not buy a second, fully billed digest turn;
 * - a deny is held until the turn is generated, so parallel blocks are not truncated;
 * - the turn ends as `stop_reason: "tool_use"`, which is what it was.
 *
 * The SDK is never spawned. Messages are plain objects on a channel the test drives one `next()` at
 * a time, which is exactly the surface `filter()` consumes (CLAUDE.md testing rules).
 */

const WEATHER: DeclaredTool = {
  name: "get_weather",
  description: "look up the weather",
  input_schema: {
    type: "object",
    properties: { cityName: { type: "string" }, units: { type: "string" } },
    required: ["cityName"],
  },
}

interface Channel {
  readonly messages: AsyncIterable<unknown>
  send(message: unknown): void
  end(): void
}

function channel(): Channel {
  const buffered: IteratorResult<unknown>[] = []
  let waiting: ((result: IteratorResult<unknown>) => void) | null = null

  const deliver = (result: IteratorResult<unknown>): void => {
    if (waiting === null) {
      buffered.push(result)
      return
    }
    const resolve = waiting
    waiting = null
    resolve(result)
  }

  return {
    messages: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const ready = buffered.shift()
          if (ready !== undefined) return Promise.resolve(ready)
          return new Promise<IteratorResult<unknown>>((resolve) => {
            waiting = resolve
          })
        },
      }),
    },
    send: (message) => deliver({ done: false, value: message }),
    end: () => deliver({ done: true, value: undefined }),
  }
}

function streamEvent(event: Record<string, unknown>, parentToolUseId: string | null = null) {
  return { type: "stream_event", event, parent_tool_use_id: parentToolUseId }
}

const MESSAGE_START = streamEvent({
  type: "message_start",
  message: {
    id: "msg_up",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [],
  },
})

const MESSAGE_DELTA = streamEvent({
  type: "message_delta",
  delta: { stop_reason: "tool_use", stop_sequence: null },
  usage: { output_tokens: 12 },
})

function toolBlock(index: number, id: string, fragments: readonly string[]) {
  return [
    streamEvent({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name: qualifyToolName("get_weather"), input: {} },
    }),
    ...fragments.map((partial) =>
      streamEvent({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partial },
      }),
    ),
    streamEvent({ type: "content_block_stop", index }),
  ]
}

/** Runs a finite message list through the gate and collects what the renderer would have seen. */
async function through(passthrough: Passthrough, messages: readonly unknown[]) {
  const source = (async function* () {
    for (const message of messages) yield message
  })()
  const seen: unknown[] = []
  for await (const message of passthrough.filter(source)) seen.push(message)
  return seen
}

function events(seen: readonly unknown[]): Record<string, unknown>[] {
  return seen
    .filter(
      (m): m is { event: Record<string, unknown> } =>
        typeof m === "object" && m !== null && "event" in m,
    )
    .map((m) => m.event)
}

function hookOf(passthrough: Passthrough): HookCallback {
  const callback = passthrough.hooks.PreToolUse?.[0]?.hooks[0]
  if (callback === undefined) throw new Error("a PreToolUse hook must be registered")
  return callback
}

function preToolUse(id: string, input: unknown): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: "/data",
    tool_name: qualifyToolName("get_weather"),
    tool_input: input,
    tool_use_id: id,
  }
}

/** One turn of the event loop, so a held hook can settle if it is going to. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function passthroughFor(tools: readonly DeclaredTool[] = [WEATHER], abort?: () => void) {
  const created = createPassthrough({ tools, ...(abort === undefined ? {} : { abort }) })
  if (created === null) throw new Error("a client that declared tools must get a passthrough")
  return created
}

describe("what the client is handed for a tool call", () => {
  test("the mcp__client__ prefix is off the name the client actually parses", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName"', ':"Berlin"}']),
    ])
    const start = events(seen).find((e) => e.type === "content_block_start")
    expect(start?.content_block).toMatchObject({ type: "tool_use", name: "get_weather" })
  })

  test("arguments are re-emitted once, repaired, and the block still closes after them", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"city_name":', '"Berlin"}']),
    ])
    const wire = events(seen).map((e) => e.type)
    expect(wire).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
    const delta = events(seen).find((e) => e.type === "content_block_delta")
    expect(delta?.delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"cityName":"Berlin"}',
    })
  })

  test("text blocks are never held — buffering is the tool path's cost alone", async () => {
    const passthrough = passthroughFor()
    const text = [
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "a" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "b" },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ]
    const seen = await through(passthrough, [MESSAGE_START, ...text])
    expect(seen).toHaveLength(5)
    expect(seen[2]).toBe(text[1])
  })

  test("arguments that do not parse are forwarded exactly as the model spelled them", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Ber']),
    ])
    const delta = events(seen).find((e) => e.type === "content_block_delta")
    expect(delta?.delta).toEqual({ type: "input_json_delta", partial_json: '{"cityName":"Ber' })
  })

  test("a subagent's blocks are left alone — the envelope drops that turn whole", async () => {
    const passthrough = passthroughFor()
    const sub = streamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: qualifyToolName("get_weather") },
      },
      "parent_call",
    )
    const seen = await through(passthrough, [MESSAGE_START, sub])
    expect(seen[1]).toBe(sub)
    expect(passthrough.integrity().emitted).toBe(0)
  })
})

describe("the PreToolUse hook denies, captures, and holds", () => {
  test("every call is denied with the router's own reason, and nothing is executed", async () => {
    const passthrough = passthroughFor()
    // No `message_delta` is needed here: the hold releases when the stream ends, and this stream
    // never started. What is asserted is the decision, which is never anything but a deny.
    const output = await hookOf(passthrough)(preToolUse("toolu_1", { cityName: "Berlin" }), "t", {
      signal: AbortSignal.abort(),
    })
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    })
    expect(passthrough.captures).toEqual([
      { id: "toolu_1", name: "get_weather", input: { cityName: "Berlin" } },
    ])
  })

  test("a deny is held until message_delta, so parallel blocks are not truncated", async () => {
    const passthrough = passthroughFor()
    const source = channel()
    const stream = passthrough.filter(source.messages)[Symbol.asyncIterator]()

    source.send(MESSAGE_START)
    await stream.next()

    let settled = false
    const denied = hookOf(passthrough)(preToolUse("toolu_1", { cityName: "Berlin" }), "t", {
      signal: new AbortController().signal,
    }).then((output) => {
      settled = true
      return output
    })

    await tick()
    expect(settled).toBe(false)

    source.send(MESSAGE_DELTA)
    await stream.next()
    await denied
    expect(settled).toBe(true)
  })

  test("a held deny never outlives the stream", async () => {
    const passthrough = passthroughFor()
    const source = channel()
    const stream = passthrough.filter(source.messages)[Symbol.asyncIterator]()

    source.send(MESSAGE_START)
    await stream.next()
    const denied = hookOf(passthrough)(preToolUse("toolu_1", {}), "t", {
      signal: new AbortController().signal,
    })

    source.end()
    await stream.next()
    expect(await denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
  })
})

describe("the turn ends once, as tool_use", () => {
  test("the digest turn is aborted as soon as every emitted call has been denied", async () => {
    let aborted = 0
    const passthrough = passthroughFor([WEATHER], () => {
      aborted += 1
    })
    const source = channel()
    const seen: unknown[] = []
    const drained = (async () => {
      for await (const message of passthrough.filter(source.messages)) seen.push(message)
    })()

    const turn = [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']),
      MESSAGE_DELTA,
    ]
    for (const message of turn) source.send(message)
    await tick()

    await hookOf(passthrough)(preToolUse("toolu_1", { cityName: "Berlin" }), "t", {
      signal: new AbortController().signal,
    })
    expect(aborted).toBe(1)

    // The subprocess is gone and nothing more will arrive on the channel, yet the loop still ends
    // on its own terms rather than stalling or surfacing the abort as a failure.
    await drained
    expect(seen.at(-1)).toMatchObject({ type: "result", stop_reason: "tool_use" })
  })

  test("a second message_start after a tool call suppresses everything that follows it", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']),
      MESSAGE_DELTA,
      MESSAGE_START,
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    ])
    expect(events(seen).map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
    ])
    expect(seen.at(-1)).toMatchObject({ type: "result", stop_reason: "tool_use" })
  })

  test("a second message_start with no tool call in the turn is not suppressed", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [MESSAGE_START, MESSAGE_DELTA, MESSAGE_START])
    expect(events(seen)).toHaveLength(3)
    expect(seen.at(-1)).not.toMatchObject({ type: "result" })
  })
})

describe("envelope integrity, because these bugs are otherwise silent", () => {
  test("a call the client was sent that no hook ever saw is reported", async () => {
    const passthrough = passthroughFor()
    await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']),
      ...toolBlock(1, "toolu_2", ['{"cityName":"Paris"}']),
    ])
    await hookOf(passthrough)(preToolUse("toolu_1", { cityName: "Berlin" }), "t", {
      signal: AbortSignal.abort(),
    })
    expect(passthrough.integrity()).toEqual({
      emitted: 2,
      captured: 1,
      uncaptured: ["toolu_2"],
      emptyInput: [],
    })
  })

  test("a call whose required arguments never arrived is reported", async () => {
    const passthrough = passthroughFor()
    await through(passthrough, [MESSAGE_START, ...toolBlock(0, "toolu_1", [])])
    expect(passthrough.integrity().emptyInput).toEqual(["toolu_1"])
  })
})

describe("the whole path, gate into renderer", () => {
  test("one Anthropic message comes out, naming the client's tool and stopping on tool_use", async () => {
    const passthrough = passthroughFor()
    const source = (async function* () {
      yield MESSAGE_START
      for (const message of toolBlock(0, "toolu_1", ['{"city_name":', '"Berlin"}'])) yield message
      yield MESSAGE_DELTA
      yield MESSAGE_START
      yield { type: "result", subtype: "success", stop_reason: "end_turn" }
    })()

    const response = await renderSdkResponse({
      messages: passthrough.filter(source),
      model: "claude-opus-5",
      stream: false,
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "get_weather", input: { cityName: "Berlin" } }],
    })
    expect(body.usage).toMatchObject({ output_tokens: 12 })
  })
})
