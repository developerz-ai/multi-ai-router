import { describe, expect, test } from "bun:test"
import { pumpBody } from "../../../src/services/dataplane/relay-pump"

const bytes = (text: string) => new TextEncoder().encode(text)

/** A source that counts how often it was asked, and how it was let go. */
function source(chunks: readonly string[]) {
  let pulls = 0
  let cancelled: unknown
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[pulls]
        pulls += 1
        if (next === undefined) controller.close()
        else controller.enqueue(bytes(next))
      },
      cancel(reason) {
        cancelled = reason
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, pulls: () => pulls, cancelled: () => cancelled }
}

function watch() {
  const seen: string[] = []
  return {
    seen,
    handlers: {
      chunk: (chunk: Uint8Array, c: ReadableStreamDefaultController<Uint8Array>) => {
        c.enqueue(chunk)
        return true
      },
      end: () => void seen.push("end"),
      failed: (error: unknown) => void seen.push(`failed:${(error as Error).name}`),
      cancelled: (error: Error) => void seen.push(`cancelled:${error.name}`),
    },
  }
}

describe("one pull stream between upstream and client", () => {
  test("reads the upstream only when the client asks: nothing is buffered ahead", async () => {
    const upstream = source(["a", "b", "c"])
    const { handlers } = watch()
    const reader = pumpBody(upstream.stream, handlers).getReader()
    await Bun.sleep(1)
    expect(upstream.pulls()).toBe(0)
    await reader.read()
    await Bun.sleep(1)
    expect(upstream.pulls()).toBe(1)
  })

  test("a chunk that produced nothing for the client is read past, not answered with silence", async () => {
    const upstream = source(["drop", "drop", "keep"])
    const { handlers, seen } = watch()
    const body = pumpBody(upstream.stream, {
      ...handlers,
      chunk: (chunk, c) => {
        if (new TextDecoder().decode(chunk) === "drop") return false
        c.enqueue(chunk)
        return true
      },
    })
    expect(await new Response(body).text()).toBe("keep")
    expect(seen).toEqual(["end"])
  })

  test("a handler that throws cancels the upstream and errors the client once", async () => {
    const upstream = source(["a", "b"])
    const { handlers, seen } = watch()
    const body = pumpBody(upstream.stream, {
      ...handlers,
      chunk: () => {
        throw new TypeError("bad frame")
      },
    })
    await expect(new Response(body).text()).rejects.toThrow("bad frame")
    expect(seen).toEqual(["failed:TypeError"])
    expect(upstream.cancelled()).toBeInstanceOf(TypeError)
  })

  test("an abort while a read is pending ends the stream with its reason and lets the upstream go", async () => {
    let cancelled = false
    const pending = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const gone = new AbortController()
    const { handlers, seen } = watch()
    const reading = pumpBody(pending, handlers, gone.signal).getReader().read()
    const deadline = new DOMException("idle", "TimeoutError")
    gone.abort(deadline)

    await expect(reading).rejects.toBe(deadline)
    expect(seen).toEqual(["failed:TimeoutError"])
    expect(cancelled).toBe(true)
  })

  test("a client cancel is told once, and no later abort is another outcome", async () => {
    const upstream = source(["a", "b"])
    const gone = new AbortController()
    const { handlers, seen } = watch()
    const reader = pumpBody(upstream.stream, handlers, gone.signal).getReader()
    await reader.read()
    await reader.cancel()
    gone.abort()

    expect(seen).toEqual(["cancelled:ClientCancelledError"])
  })

  test("last words replace the error, and the stream closes cleanly behind them", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull: (c) => c.error(new TypeError("reset")),
    })
    const { handlers, seen } = watch()
    const body = pumpBody(broken, { ...handlers, lastWords: () => bytes("bye") })
    expect(await new Response(body).text()).toBe("bye")
    expect(seen).toEqual(["failed:TypeError"])
  })
})
