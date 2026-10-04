import { describe, expect, test } from "bun:test"
import { renderSdkResponse, type Ticker } from "../../../src/providers/claude-sdk/render"

/**
 * The upstream idle deadline measures *model progress*, not transport liveness.
 *
 * Two failure shapes, both seen by Meridian in production (its #1177 and #1222):
 *
 * - A stalled turn whose upstream keeps sending `ping` events (or the SDK its `keep_alive`) used to
 *   re-arm the 90 s window on every one of them, so it never timed out — the client's heartbeat
 *   kept the connection up and the turn held its Account slot indefinitely.
 * - A timer that fires seconds late (the event loop was blocked) runs before the I/O poll that
 *   would deliver bytes already waiting in the pipe, so a live stream was failed as silent.
 *
 * Time is virtual: `advance` moves the clock and fires every timer that has come due, `jump` moves
 * it without firing, the way a blocked loop does.
 */

const IDLE_MS = 90_000
const PACING = { idleMs: IDLE_MS, heartbeatMs: 0 }

interface VirtualClock {
  readonly ticker: Ticker
  advance(ms: number): void
  jump(ms: number): void
  fireDue(): void
}

function virtualClock(yieldToIo?: () => Promise<void>): VirtualClock {
  let now = 0
  const timers: { readonly due: number; readonly fn: () => void; cancelled: boolean }[] = []
  const fireDue = (): void => {
    for (const timer of [...timers].sort((a, b) => a.due - b.due)) {
      if (timer.cancelled || timer.due > now) continue
      timer.cancelled = true
      timer.fn()
    }
  }
  return {
    ticker: {
      now: () => now,
      after(delayMs, fn) {
        const timer = { due: now + delayMs, fn, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
      ...(yieldToIo === undefined ? {} : { yieldToIo }),
    },
    advance(ms) {
      now += ms
      fireDue()
    },
    jump(ms) {
      now += ms
    },
    fireDue,
  }
}

function channel() {
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
    } satisfies AsyncIterable<unknown>,
    send: (value: unknown) => deliver({ done: false, value }),
    end: () => deliver({ done: true, value: undefined }),
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const streamEvent = (event: Record<string, unknown>) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
})
const MESSAGE_START = streamEvent({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [] },
})
const BLOCK_START = streamEvent({
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
})
const delta = (text: string) =>
  streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
const PING = streamEvent({ type: "ping" })
const KEEP_ALIVE = { type: "keep_alive" }
const RESULT = { type: "result", subtype: "success", stop_reason: "end_turn", usage: {} }

function frameNames(sse: string): string[] {
  return sse
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => (block.split("\n")[0] ?? "").slice("event: ".length))
}

async function openStream(clock: VirtualClock) {
  const source = channel()
  source.send(MESSAGE_START)
  source.send(BLOCK_START)
  const response = await renderSdkResponse({
    messages: source.messages,
    model: "m",
    stream: true,
    pacing: PACING,
    ticker: clock.ticker,
  })
  await tick()
  return { source, response }
}

async function finish(source: ReturnType<typeof channel>): Promise<void> {
  source.send(streamEvent({ type: "content_block_stop", index: 0 }))
  source.send(streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }))
  source.send(streamEvent({ type: "message_stop" }))
  source.send(RESULT)
  source.end()
  await tick()
}

describe("transport liveness never extends the upstream idle deadline", () => {
  for (const [name, heartbeat] of [
    ["stream_event ping", PING],
    ["SDK keep_alive", KEEP_ALIVE],
  ] as const) {
    test(`a stalled model emitting periodic ${name}s still hits the idle timeout`, async () => {
      const clock = virtualClock()
      const { source, response } = await openStream(clock)

      // A liveness signal every 20 s, no model output, for well past the 90 s window.
      for (let elapsed = 0; elapsed < 120_000; elapsed += 20_000) {
        source.send(heartbeat)
        await tick()
        clock.advance(20_000)
        await tick()
      }

      const names = frameNames(await response.text())
      expect(names.at(-1)).toBe("error")
      expect(names).not.toContain("message_stop")
    })
  }

  test("real model progress keeps re-arming the window", async () => {
    const clock = virtualClock()
    const { source, response } = await openStream(clock)

    for (let elapsed = 0; elapsed < 300_000; elapsed += 60_000) {
      clock.advance(60_000)
      source.send(delta("x"))
      await tick()
    }
    await finish(source)

    const names = frameNames(await response.text())
    expect(names).not.toContain("error")
    expect(names.at(-1)).toBe("message_stop")
  })
})

describe("a late-fired idle deadline gives buffered upstream bytes one I/O turn", () => {
  test("the timer fired seconds late and progress was waiting in the pipe: no timeout", async () => {
    let pipe: (() => void) | null = null
    const clock = virtualClock(async () => {
      pipe?.()
      await tick()
    })
    const { source, response } = await openStream(clock)
    pipe = () => source.send(delta("arrived during the freeze"))

    // The loop was blocked across the deadline: the timer runs 5 s after it was due.
    clock.jump(IDLE_MS + 5_000)
    clock.fireDue()
    await tick()
    pipe = null
    await finish(source)

    const body = await response.text()
    expect(frameNames(body)).not.toContain("error")
    expect(body).toContain("arrived during the freeze")
  })

  test("late, but nothing was waiting: still the idle timeout", async () => {
    const clock = virtualClock(async () => {
      await tick()
    })
    const { response } = await openStream(clock)

    clock.jump(IDLE_MS + 5_000)
    clock.fireDue()

    expect(frameNames(await response.text()).at(-1)).toBe("error")
  })

  test("late, and only a ping was waiting: a ping is not progress, so the next read times out", async () => {
    let pipe: (() => void) | null = null
    const clock = virtualClock(async () => {
      pipe?.()
      await tick()
    })
    const { source, response } = await openStream(clock)
    pipe = () => source.send(PING)

    clock.jump(IDLE_MS + 5_000)
    clock.fireDue()
    await tick()

    expect(frameNames(await response.text()).at(-1)).toBe("error")
  })

  test("an on-time timer gets no grace, even when bytes would have arrived", async () => {
    let yielded = false
    const clock = virtualClock(async () => {
      yielded = true
      await tick()
    })
    const { response } = await openStream(clock)

    clock.advance(IDLE_MS)

    expect(frameNames(await response.text()).at(-1)).toBe("error")
    expect(yielded).toBe(false)
  })
})
