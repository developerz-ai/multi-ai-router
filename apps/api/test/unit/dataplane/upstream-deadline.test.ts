import { describe, expect, test } from "bun:test"
import {
  type DeadlineClock,
  type StreamDeadlines,
  upstreamDeadline,
} from "../../../src/services/dataplane/upstream-deadline"

/**
 * A streamed HTTP attempt has three clocks, not one. Before this, a single 600 s deadline bounded
 * the whole attempt: a hung upstream held the request ten minutes before failover, and a healthy
 * generation longer than that was cut mid-stream.
 *
 * - **first byte**: no response headers yet, nothing sent to the client — expiry is a `timeout`
 *   failure the chain fails over on.
 * - **idle**: headers are in and bytes may be on the wire — expiry errors the stream honestly
 *   (`TimeoutError`, read as `upstream_timeout`), never a silent hang.
 * - **total**: the outer bound, now separate and long.
 */

function manualClock() {
  let now = 0
  let timers: { at: number; fn: () => void; live: boolean }[] = []
  const clock: DeadlineClock = {
    now: () => now,
    after(delayMs, fn) {
      const timer = { at: now + delayMs, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
  }
  return {
    clock,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = timers
          .filter((timer) => timer.live && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        now = due.at
        due.live = false
        due.fn()
      }
      now = target
      timers = timers.filter((timer) => timer.live)
    },
    pending: () => timers.filter((timer) => timer.live).length,
  }
}

const DEADLINES: StreamDeadlines = { firstByteMs: 1_000, idleMs: 500, totalMs: 10_000 }

function controlledBody() {
  let control!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller
    },
  })
  return {
    body,
    send: (text: string) => control.enqueue(new TextEncoder().encode(text)),
    fail: (reason: unknown) => control.error(reason),
    close: () => control.close(),
  }
}

/** A real fetch errors its body with the signal's reason; this stands in for one. */
function bodyBoundTo(signal: AbortSignal) {
  const body = controlledBody()
  signal.addEventListener("abort", () => body.fail(signal.reason), { once: true })
  return body
}

describe("upstreamDeadline", () => {
  test("no headers within the first-byte window aborts as a TimeoutError, before the total", () => {
    const time = manualClock()
    const deadline = upstreamDeadline({ stream: DEADLINES, clock: time.clock })
    time.advance(999)
    expect(deadline.signal.aborted).toBe(false)
    time.advance(1)
    expect(deadline.signal.aborted).toBe(true)
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError")
    expect(deadline.expired()).toBe("first-byte")
  })

  test("headers stop the first-byte clock; a steady stream outlives the old 600 s bound", async () => {
    const time = manualClock()
    const deadline = upstreamDeadline({
      stream: { firstByteMs: 1_000, idleMs: 30_000, totalMs: 3_600_000 },
      clock: time.clock,
    })
    time.advance(900)
    deadline.headersArrived()
    const upstream = bodyBoundTo(deadline.signal)
    const reader = deadline.watch(new Response(upstream.body)).body?.getReader()
    for (let minute = 0; minute < 15; minute += 1) {
      upstream.send("data: x\n\n")
      await reader?.read()
      time.advance(20_000)
      upstream.send("data: x\n\n")
      await reader?.read()
      time.advance(20_000)
      upstream.send("data: x\n\n")
      await reader?.read()
      time.advance(20_000)
    }
    expect(deadline.signal.aborted).toBe(false)
    upstream.close()
    expect((await reader?.read())?.done).toBe(true)
    expect(time.pending()).toBe(0)
  })

  test("silence past the idle window, while the router waits on the upstream, errors the stream", async () => {
    const time = manualClock()
    const deadline = upstreamDeadline({ stream: DEADLINES, clock: time.clock })
    deadline.headersArrived()
    const upstream = bodyBoundTo(deadline.signal)
    const reader = deadline.watch(new Response(upstream.body)).body?.getReader()
    upstream.send("data: one\n\n")
    await reader?.read()
    const next = reader?.read().then(
      () => null,
      (error: unknown) => error,
    )
    await Promise.resolve()
    time.advance(499)
    expect(deadline.signal.aborted).toBe(false)
    time.advance(1)
    expect(deadline.expired()).toBe("idle")
    const failure = await next
    expect(failure instanceof Error && failure.name).toBe("TimeoutError")
  })

  test("a client that stops reading is backpressure, not an upstream stall", async () => {
    const time = manualClock()
    const deadline = upstreamDeadline({ stream: DEADLINES, clock: time.clock })
    deadline.headersArrived()
    const upstream = bodyBoundTo(deadline.signal)
    const reader = deadline.watch(new Response(upstream.body)).body?.getReader()
    upstream.send("data: one\n\n")
    await reader?.read()
    // Nobody asks for the next chunk for longer than the idle window.
    time.advance(5_000)
    expect(deadline.signal.aborted).toBe(false)
    upstream.send("data: two\n\n")
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: two\n\n")
  })

  test("the total deadline still bounds a stream that never goes idle", async () => {
    const time = manualClock()
    const deadline = upstreamDeadline({ stream: DEADLINES, clock: time.clock })
    deadline.headersArrived()
    const upstream = bodyBoundTo(deadline.signal)
    const reader = deadline.watch(new Response(upstream.body)).body?.getReader()
    for (let elapsed = 0; elapsed < 10_000; elapsed += 400) {
      upstream.send("x")
      await reader?.read()
      time.advance(400)
    }
    expect(deadline.expired()).toBe("total")
  })

  test("the client going away stops every clock", () => {
    const time = manualClock()
    const client = new AbortController()
    const deadline = upstreamDeadline({
      stream: DEADLINES,
      client: client.signal,
      clock: time.clock,
    })
    client.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(time.pending()).toBe(0)
    expect(deadline.expired()).toBeUndefined()
  })

  test("release stops every clock on a path that never relays a body", () => {
    const time = manualClock()
    const deadline = upstreamDeadline({ stream: DEADLINES, clock: time.clock })
    deadline.headersArrived()
    deadline.release()
    expect(time.pending()).toBe(0)
  })
})

/**
 * Every way out of a watched attempt releases every clock and the client listener, exactly once.
 * PR #307 review: a connection reset rejected the upstream read, the wrapper errored, and its timers,
 * client listener and closures were retained until the total deadline fired.
 */
describe("every exit releases every clock and the client listener exactly once", () => {
  function setup() {
    const time = manualClock()
    const client = new AbortController()
    let removed = 0
    const remove = client.signal.removeEventListener.bind(client.signal)
    client.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      if (args[0] === "abort") removed += 1
      remove(...args)
    }) as typeof client.signal.removeEventListener
    const deadline = upstreamDeadline({
      stream: DEADLINES,
      client: client.signal,
      clock: time.clock,
    })
    return { time, client, deadline, removed: () => removed }
  }

  function watched(deadline: ReturnType<typeof upstreamDeadline>) {
    deadline.headersArrived()
    const upstream = controlledBody()
    const reader = deadline.watch(new Response(upstream.body)).body?.getReader()
    if (reader === undefined) throw new Error("no body")
    return { upstream, reader }
  }

  function settled(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    )
  }

  function expectReleased(env: ReturnType<typeof setup>) {
    expect(env.time.pending()).toBe(0)
    expect(env.removed()).toBe(1)
    env.deadline.release()
    expect(env.removed()).toBe(1)
  }

  test("the upstream ends cleanly", async () => {
    const env = setup()
    const { upstream, reader } = watched(env.deadline)
    upstream.close()
    expect((await reader.read()).done).toBe(true)
    expectReleased(env)
  })

  test("the client cancels the body", async () => {
    const env = setup()
    const { reader } = watched(env.deadline)
    await reader.cancel("gone")
    expectReleased(env)
  })

  test("the upstream read rejects (connection reset), and the original error reaches the client", async () => {
    const env = setup()
    const { upstream, reader } = watched(env.deadline)
    const reset = new Error("ECONNRESET")
    const next = settled(reader.read())
    upstream.fail(reset)
    expect(await next).toBe(reset)
    expectReleased(env)
  })

  test("the idle clock fires", async () => {
    const env = setup()
    const { reader } = watched(env.deadline)
    const next = settled(reader.read())
    await Promise.resolve()
    env.time.advance(DEADLINES.idleMs)
    expect((await next) instanceof Error).toBe(true)
    expectReleased(env)
  })

  test("the first-byte clock fires", () => {
    const env = setup()
    env.time.advance(DEADLINES.firstByteMs)
    expect(env.deadline.expired()).toBe("first-byte")
    expectReleased(env)
  })

  test("the total clock fires", async () => {
    const env = setup()
    const { upstream, reader } = watched(env.deadline)
    for (let elapsed = 0; elapsed < DEADLINES.totalMs; elapsed += 400) {
      upstream.send("x")
      await reader.read()
      env.time.advance(400)
    }
    expect(env.deadline.expired()).toBe("total")
    expectReleased(env)
  })

  test("the client goes away", () => {
    const env = setup()
    env.client.abort()
    expectReleased(env)
  })

  test("a path that never relays a body releases explicitly", () => {
    const env = setup()
    env.deadline.headersArrived()
    env.deadline.release()
    expectReleased(env)
  })

  test("a body watched after release arms nothing", () => {
    const env = setup()
    env.deadline.release()
    env.deadline.watch(new Response("late"))
    expectReleased(env)
  })
})
