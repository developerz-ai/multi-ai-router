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
      // Both blocks closed on the wire, so the flush had nothing left to close.
      flushedBlocks: 0,
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

/**
 * **What the client gets when the loop ends before a tool block closes.**
 *
 * A tool block's arguments are held until its `content_block_stop` (`rewrite.ts`), and the early
 * stop ends the loop the instant every emitted call has been denied — a race the stop sometimes
 * wins. The held fragments then died with the loop, and the client received a `tool_use` block with
 * its name, its id, and nothing else: `arguments: ""` on the openai wire, which is not JSON, so the
 * client's reader threw before it could run anything. Measured at ~1.4% of requests under agent
 * load, always exactly one block, and fatal to the whole turn every time (2026-09-06).
 */
describe("a tool block whose content_block_stop never arrives", () => {
  /** The block, without its stop — the shape the stop-versus-stop race leaves behind. */
  function unterminatedToolBlock(fragments: readonly string[]) {
    return toolBlock(0, "toolu_1", fragments).slice(0, -1)
  }

  function argumentsOf(seen: readonly unknown[]): string {
    return events(seen)
      .filter((event) => event.type === "content_block_delta")
      .map((event) => {
        const delta = event.delta as { partial_json?: unknown } | undefined
        return typeof delta?.partial_json === "string" ? delta.partial_json : ""
      })
      .join("")
  }

  test("the held arguments still reach the client, and the block still closes", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...unterminatedToolBlock(['{"cityName"', ':"Berlin"}']),
    ])

    expect(JSON.parse(argumentsOf(seen))).toEqual({ cityName: "Berlin" })
    // Sound framing too: a block the client opened is a block the client sees closed.
    expect(events(seen).filter((event) => event.type === "content_block_stop")).toHaveLength(1)
  })

  test("the hook's assembled input wins over a buffer that only got half of it", async () => {
    const passthrough = passthroughFor()
    // The hook sees the arguments whole; the stream carried only the opening fragment before the
    // loop ended. A truncated prefix of valid JSON is still not valid JSON.
    // An already-aborted signal, so the deny-hold resolves at once: this test is about the capture,
    // not about the hold that `the deny is held until the turn is generated` already pins.
    await hookOf(passthrough)(
      preToolUse("toolu_1", { cityName: "Berlin", units: "metric" }),
      undefined,
      { signal: AbortSignal.abort() },
    )
    const seen = await through(passthrough, [MESSAGE_START, ...unterminatedToolBlock(['{"cityNa'])])

    expect(JSON.parse(argumentsOf(seen))).toEqual({ cityName: "Berlin", units: "metric" })
  })

  test("a block that closed on the wire is not flushed a second time", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']),
      MESSAGE_DELTA,
    ])

    expect(events(seen).filter((event) => event.type === "content_block_stop")).toHaveLength(1)
    expect(JSON.parse(argumentsOf(seen))).toEqual({ cityName: "Berlin" })
  })
})

/**
 * **What the flushed events are wrapped in**, which is not the same question as what they contain.
 *
 * The renderer discriminates on the SDK message's `type` (`render/events.ts`), so a
 * `content_block_stop` that arrives inside anything other than a `stream_event` is read as some
 * other kind of message and its event is never looked at. The block then stays open, the envelope
 * force-closes it, and the turn is answered as truncated — with the flush having run and produced
 * exactly the right events.
 *
 * Production, 2026-09-06: `blocks: 1, kinds: ["tool_use"], lastMessage: "assistant",
 * declaredTools: 12, passthrough: true`. The passthrough existed and the flush ran; the last SDK
 * message before the loop ended happened to be an `assistant` one, and the flush was wrapped
 * against it.
 */
describe("the wrapper a flushed event arrives in", () => {
  function types(seen: readonly unknown[]): string[] {
    return seen.map((m) =>
      typeof m === "object" && m !== null && "type" in m
        ? String((m as { type: unknown }).type)
        : "",
    )
  }

  test("every flushed event is a stream_event, whatever the loop's last message was", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']).slice(0, -1),
      // The SDK's assembled message for the turn, which is routinely the last thing before the
      // stream ends — and is not a `stream_event`.
      { type: "assistant", uuid: "asst_1", message: { role: "assistant", content: [] } },
    ])

    // Nothing the renderer would read as an assistant message may carry a wire event.
    for (const message of seen) {
      if (typeof message !== "object" || message === null) continue
      if (!("event" in message)) continue
      expect((message as { type: unknown }).type).toBe("stream_event")
    }
    expect(types(seen).filter((type) => type === "stream_event").length).toBeGreaterThan(0)
  })

  test("and it still carries the arguments and the close", async () => {
    const passthrough = passthroughFor()
    const seen = await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']).slice(0, -1),
      { type: "assistant", uuid: "asst_1", message: { role: "assistant", content: [] } },
    ])

    const wire = events(seen)
    expect(wire.filter((event) => event.type === "content_block_stop")).toHaveLength(1)
    const args = wire
      .filter((event) => event.type === "content_block_delta")
      .map((event) => (event.delta as { partial_json?: string } | undefined)?.partial_json ?? "")
      .join("")
    expect(JSON.parse(args)).toEqual({ cityName: "Berlin" })
  })
})

/**
 * The whole path, asserting the outcome the production line reported rather than the wrapper that
 * caused it: a tool turn whose `content_block_stop` never arrives and whose last SDK message is an
 * `assistant` one must reach the client complete, and must raise no truncation alarm.
 */
describe("a tool turn that ends on an assistant message", () => {
  const source = () =>
    (async function* () {
      yield MESSAGE_START
      // No `content_block_stop`: the early stop wins its race with it, which is the whole shape.
      for (const message of toolBlock(0, "toolu_1", ['{"cityName"', ':"Berlin"}']).slice(0, -1)) {
        yield message
      }
      yield { type: "assistant", uuid: "asst_1", message: { role: "assistant", content: [] } }
    })()

  test("nothing is reported truncated: the flush closed the block, as it was always meant to", async () => {
    const alarms: unknown[] = []
    const response = await renderSdkResponse({
      messages: passthroughFor().filter(source()),
      model: "claude-opus-5",
      stream: false,
      observer: { onTruncatedTurn: (detail) => void alarms.push(detail) },
    })

    expect(alarms).toEqual([])
    // And it is a real answer, not the 502 a truncated turn is answered with.
    expect(response.status).toBe(200)
  })

  test("the client's tool call arrives whole, arguments included", async () => {
    const response = await renderSdkResponse({
      messages: passthroughFor().filter(source()),
      model: "claude-opus-5",
      stream: false,
    })
    const body = (await response.json()) as {
      content: { type: string; name?: string; input?: unknown }[]
    }

    const call = body.content.find((block) => block.type === "tool_use")
    expect(call).toMatchObject({ name: "get_weather", input: { cityName: "Berlin" } })
  })
})

/**
 * `flushedBlocks` exists because three plausible reproductions of the production shape — a stream
 * that ends after a `user` message, one that throws after the block opened, one that throws
 * immediately — all close their blocks correctly. The log line has to be able to say which of them
 * production is *not*, and this is the field that does it: non-zero means the rewriter held that
 * block and closed it, so anything the renderer still had open was never the rewriter's.
 */
describe("what the flush reports it closed", () => {
  test("it counts the blocks it had to close, and only those", async () => {
    const passthrough = passthroughFor()
    await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']).slice(0, -1),
    ])

    expect(passthrough.integrity().flushedBlocks).toBe(1)
  })

  test("an ordinary turn flushes nothing", async () => {
    const passthrough = passthroughFor()
    await through(passthrough, [
      MESSAGE_START,
      ...toolBlock(0, "toolu_1", ['{"cityName":"Berlin"}']),
      MESSAGE_DELTA,
    ])

    expect(passthrough.integrity().flushedBlocks).toBe(0)
  })
})
