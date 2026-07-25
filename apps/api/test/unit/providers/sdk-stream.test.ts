import { describe, expect, test } from "bun:test"
import { isRouterError } from "@multi-ai-router/core"
import type { Ticker } from "../../../src/providers/claude-sdk/render/idle-guard"
import { renderSdkResponse } from "../../../src/providers/claude-sdk/render/stream"

/**
 * Driving a `query()` stream into an Anthropic response.
 *
 * Two properties are asserted here that the pure pieces cannot state on their own
 * (docs/idea/11-anthropic-agent-sdk.md §6, §9):
 *
 * - **The status is decided before the first byte.** A stall on the way to the first frame is a
 *   real `504`; a stall after it is a terminal `error` frame inside a `200`, because a response in
 *   flight cannot retract its status and pretending otherwise would be the dishonest close.
 * - **The heartbeat does not hide the stall.** `: ping` and the upstream idle guard are two clocks,
 *   and the test fires them independently to prove they are.
 *
 * Timers are injected rather than waited on: a real 90 s guard is not a test anyone runs, and a
 * shortened one is a flake. No `mock()` anywhere — the ticker and the message source are ordinary
 * values (CLAUDE.md testing rules).
 */

const MODEL = "claude-sonnet-4-5"
const PACING = { idleMs: 90_000, heartbeatMs: 15_000 }

interface FakeTicker {
  readonly ticker: Ticker
  /** Fires every live timer armed for exactly this delay. */
  fire(delayMs: number): void
  pending(): readonly number[]
}

function fakeTicker(): FakeTicker {
  const timers: { readonly delayMs: number; readonly fn: () => void; cancelled: boolean }[] = []
  return {
    ticker: {
      after(delayMs, fn) {
        const timer = { delayMs, fn, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
    },
    fire(delayMs) {
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.delayMs !== delayMs) continue
        timer.cancelled = true
        timer.fn()
      }
    },
    pending() {
      return timers.filter((timer) => !timer.cancelled).map((timer) => timer.delayMs)
    },
  }
}

interface Channel {
  readonly messages: AsyncIterable<unknown>
  send(message: unknown): void
  end(): void
}

/** A message source the test drives one `next()` at a time, the way a subprocess would. */
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

/** One turn of the event loop, so the renderer can arm its next race. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function streamEvent(event: Record<string, unknown>, parentToolUseId: string | null = null) {
  return { type: "stream_event", event, parent_tool_use_id: parentToolUseId }
}

const MESSAGE_START = streamEvent({
  type: "message_start",
  message: { id: "msg_upstream", type: "message", role: "assistant", model: MODEL, content: [] },
})

const TEXT = [
  streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
  streamEvent({ type: "content_block_stop", index: 0 }),
]

const RESULT = {
  type: "result",
  subtype: "success",
  stop_reason: "end_turn",
  usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 100 },
}

/** A source that yields a fixed list and ends. */
function finite(messages: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
  }
}

function events(sse: string): { readonly name: string; readonly data: unknown }[] {
  return sse
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const [name = "", data = ""] = block.split("\n")
      return { name: name.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) }
    })
}

describe("rendering a streaming turn", () => {
  test("only stream_event payloads reach the client, and the envelope is closed once", async () => {
    const response = await renderSdkResponse({
      messages: finite([
        { type: "system", subtype: "init", session_id: "sess_1" },
        MESSAGE_START,
        ...TEXT,
        { type: "assistant", message: { content: [] }, usage: { output_tokens: 1 } },
        { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
        RESULT,
      ]),
      model: MODEL,
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")

    const frames = events(await response.text())
    expect(frames.map((frame) => frame.name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("every frame is flushed as it is produced — nothing waits for the turn to end", async () => {
    const source = channel()
    source.send(MESSAGE_START)

    const response = await renderSdkResponse({
      messages: source.messages,
      model: MODEL,
      stream: true,
    })
    const body = response.body
    if (body === null) throw new Error("a streaming response has a body")
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const read = async (): Promise<string> => decoder.decode((await reader.read()).value)

    // The turn is still open, and the client already has its first frame.
    expect(await read()).toContain("event: message_start")
    source.send(TEXT[0])
    expect(await read()).toContain("event: content_block_start")

    await reader.cancel()
  })

  test("the result message is the authoritative usage and stop reason", async () => {
    const response = await renderSdkResponse({
      messages: finite([
        MESSAGE_START,
        streamEvent({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 1 },
        }),
        RESULT,
      ]),
      model: MODEL,
      stream: true,
    })

    const frames = events(await response.text())
    expect(frames.find((frame) => frame.name === "message_delta")?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2, input_tokens: 7, cache_read_input_tokens: 100 },
    })
  })

  test("session ids and rate-limit events are captured, never forwarded", async () => {
    const sessions: string[] = []
    const limits: unknown[] = []

    const response = await renderSdkResponse({
      messages: finite([
        { type: "system", subtype: "init", session_id: "sess_1" },
        { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
        MESSAGE_START,
        RESULT,
      ]),
      model: MODEL,
      stream: true,
      observer: {
        onSession: (id) => sessions.push(id),
        onRateLimit: (info) => limits.push(info),
      },
    })
    const body = await response.text()

    expect(sessions).toEqual(["sess_1"])
    expect(limits).toEqual([{ status: "allowed_warning" }])
    expect(body).not.toContain("sess_1")
    expect(body).not.toContain("allowed_warning")
  })

  test("an observer that throws degrades reporting, not the response", async () => {
    const response = await renderSdkResponse({
      messages: finite([{ type: "system", subtype: "init", session_id: "sess_1" }, MESSAGE_START]),
      model: MODEL,
      stream: true,
      observer: {
        onSession: () => {
          throw new Error("observer is broken")
        },
      },
    })

    expect(events(await response.text()).at(-1)?.name).toBe("message_stop")
  })

  test("a turn that produced nothing is an empty completion, not a fabricated one", async () => {
    const response = await renderSdkResponse({
      messages: finite([{ type: "result", subtype: "success", stop_reason: "end_turn" }]),
      model: MODEL,
      stream: true,
      newId: () => "msg_fixed",
    })

    const frames = events(await response.text())
    expect(frames.map((frame) => frame.name)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ])
    expect(frames[0]?.data).toMatchObject({ message: { id: "msg_fixed", content: [] } })
  })
})

describe("rendering a non-streaming turn", () => {
  test("folds the same events into one Anthropic message", async () => {
    const response = await renderSdkResponse({
      messages: finite([MESSAGE_START, ...TEXT, RESULT]),
      model: MODEL,
      stream: false,
    })

    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.json()).toEqual({
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { output_tokens: 2, input_tokens: 7, cache_read_input_tokens: 100 },
      content: [{ type: "text", text: "hi" }],
    })
  })

  test("an upstream error is relayed as one, never as a 200 carrying an error body", async () => {
    const failure = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
    const response = await renderSdkResponse({
      messages: finite([MESSAGE_START, streamEvent(failure)]),
      model: MODEL,
      stream: false,
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual(failure)
  })
})

describe("the upstream idle guard", () => {
  test("a stall before the first byte is a 504, not a 200 carrying an apology", async () => {
    const timers = fakeTicker()
    const source = channel()

    const pending = renderSdkResponse({
      messages: source.messages,
      model: MODEL,
      stream: true,
      pacing: PACING,
      ticker: timers.ticker,
    })

    await tick()
    timers.fire(PACING.idleMs)

    const error: unknown = await pending.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(isRouterError(error) && error.status).toBe(504)
  })

  test("a stall after the first byte closes with an error frame inside the 200", async () => {
    const timers = fakeTicker()
    const source = channel()
    source.send(MESSAGE_START)

    const response = await renderSdkResponse({
      messages: source.messages,
      model: MODEL,
      stream: true,
      pacing: PACING,
      ticker: timers.ticker,
    })
    expect(response.status).toBe(200)

    await tick()
    timers.fire(PACING.idleMs)

    const frames = events(await response.text())
    expect(frames.map((frame) => frame.name)).toEqual(["message_start", "error"])
    expect(frames[1]?.data).toMatchObject({ error: { type: "api_error" } })
  })

  test("the heartbeat is a separate clock and does not silence the guard", async () => {
    const timers = fakeTicker()
    const source = channel()
    source.send(MESSAGE_START)

    const response = await renderSdkResponse({
      messages: source.messages,
      model: MODEL,
      stream: true,
      pacing: PACING,
      ticker: timers.ticker,
    })

    await tick()
    // Six keep-alives go out over a stall the client would otherwise have timed out on...
    for (let beat = 0; beat < 6; beat += 1) timers.fire(PACING.heartbeatMs)
    // ...and the upstream guard still fires, because it was never reset by any of them.
    timers.fire(PACING.idleMs)

    const body = await response.text()
    expect(body.split(": ping\n\n")).toHaveLength(7)
    expect(events(body).at(-1)?.name).toBe("error")
  })

  test("both clocks stop once the turn is over", async () => {
    const timers = fakeTicker()
    const response = await renderSdkResponse({
      messages: finite([MESSAGE_START, RESULT]),
      model: MODEL,
      stream: true,
      pacing: PACING,
      ticker: timers.ticker,
    })
    await response.text()

    expect(timers.pending()).toEqual([])
  })

  test("a non-streaming turn arms no keep-alive at all", async () => {
    const timers = fakeTicker()
    await renderSdkResponse({
      messages: finite([MESSAGE_START, RESULT]),
      model: MODEL,
      stream: false,
      pacing: PACING,
      ticker: timers.ticker,
    })

    expect(timers.pending()).toEqual([])
  })
})
