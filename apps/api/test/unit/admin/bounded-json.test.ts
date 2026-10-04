import { describe, expect, test } from "bun:test"
import { RequestTooLargeError } from "../../../../../packages/core/src/errors"
import { readBoundedJsonBody } from "../../../src/services/admin/bounded-json"

const headerCases: Record<string, string>[] = [{}, { "content-length": "1" }]
const encode = (value: string) => new TextEncoder().encode(value)
const request = (
  body: ReadableStream<Uint8Array> | string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) =>
  new Request("http://fixture/api/admin/auth/login", {
    method: "POST",
    body,
    headers,
    signal,
    duplex: "half",
  } as RequestInit)
describe("bounded admin/login JSON prototype", () => {
  test("UTF8 byte ceiling accepts exact bytes across every split", async () => {
    const raw = encode(JSON.stringify({ password: "é😄" }))
    for (let split = 1; split < raw.length; split++) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(raw.slice(0, split))
          c.enqueue(raw.slice(split))
          c.close()
        },
      })
      expect(await readBoundedJsonBody(request(stream), { maximumBytes: raw.length })).toEqual({
        password: "é😄",
      })
    }
  })
  test("absent or understated length cannot bypass byte ceiling; hung cancel is not awaited", async () => {
    for (const headers of headerCases) {
      let cancelled = 0
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encode('{"password":"oversized"}'))
        },
        cancel() {
          cancelled++
          return new Promise(() => {})
        },
      })
      await expect(
        readBoundedJsonBody(request(stream, headers), { maximumBytes: 8 }),
      ).rejects.toBeInstanceOf(RequestTooLargeError)
      expect(cancelled).toBe(1)
    }
  })
  test("declared huge length rejects before pulling or decoding and cancels body", async () => {
    let pulled = 0,
      cancelled = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled++
        },
        cancel() {
          cancelled++
        },
      },
      { highWaterMark: 0 },
    )
    await expect(
      readBoundedJsonBody(request(stream, { "content-length": "999999999999999999999999" }), {
        maximumBytes: 64,
      }),
    ).rejects.toMatchObject({ status: 413, code: "request_too_large" })
    expect(pulled).toBe(0)
    expect(cancelled).toBe(1)
  })
  test("malformed JSON preserves validation failure; empty JSON body is not a500", async () => {
    expect(await readBoundedJsonBody(request("not JSON"), { maximumBytes: 64 })).toBeNull()
    expect(await readBoundedJsonBody(request(""), { maximumBytes: 64 })).toBeNull()
  })
  test("caller abort releases blocked read without awaiting hung source cancellation", async () => {
    const controller = new AbortController()
    const reason = new Error("fixture abort")
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {})
      },
      cancel() {
        cancelled++
        return new Promise(() => {})
      },
    })
    const read = readBoundedJsonBody(request(stream, {}, controller.signal), { maximumBytes: 64 })
    controller.abort(reason)
    await expect(read).rejects.toBe(reason)
    expect(cancelled).toBe(1)
  })
  test("invalid length is not trusted; counting still rejects before JSON parse", async () => {
    await expect(
      readBoundedJsonBody(request('{"large":true}', { "content-length": "not-a-number" }), {
        maximumBytes: 4,
      }),
    ).rejects.toBeInstanceOf(RequestTooLargeError)
  })
  test("twenty thousand one-byte chunks retain at most one abort listener", async () => {
    const value = { password: "x".repeat(20000) }
    const raw = encode(JSON.stringify(value))
    let offset = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (offset === raw.length) {
            c.close()
            return
          }
          c.enqueue(raw.subarray(offset, ++offset))
        },
      },
      { highWaterMark: 0 },
    )
    const req = request(stream)
    const signal = req.signal
    let live = 0,
      maximumLive = 0,
      added = 0,
      removed = 0
    const add = signal.addEventListener.bind(signal),
      remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      if (args[0] === "abort") {
        live++
        added++
        maximumLive = Math.max(maximumLive, live)
      }
      return add(...(args as Parameters<typeof add>))
    }) as typeof add
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      if (args[0] === "abort") {
        live--
        removed++
      }
      return remove(...(args as Parameters<typeof remove>))
    }) as typeof remove
    expect(await readBoundedJsonBody(req, { maximumBytes: raw.length })).toEqual(value)
    expect(maximumLive).toBe(1)
    expect(live).toBe(0)
    expect(added).toBe(raw.length + 1)
    expect(removed).toBe(added)
    expect(stream.locked).toBe(false)
  })
  test("source error releases its reader and abort listener without swallowing the reason", async () => {
    const failure = new Error("fixture source failure")
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          c.error(failure)
        },
      },
      { highWaterMark: 0 },
    )
    const req = request(stream)
    let live = 0
    const add = req.signal.addEventListener.bind(req.signal),
      remove = req.signal.removeEventListener.bind(req.signal)
    req.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      if (args[0] === "abort") live++
      return add(...(args as Parameters<typeof add>))
    }) as typeof add
    req.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      if (args[0] === "abort") live--
      return remove(...(args as Parameters<typeof remove>))
    }) as typeof remove
    await expect(readBoundedJsonBody(req, { maximumBytes: 64 })).rejects.toBe(failure)
    expect(live).toBe(0)
    expect(stream.locked).toBe(false)
  })
})
