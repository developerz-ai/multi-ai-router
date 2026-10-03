import { expect, spyOn, test } from "bun:test"
import { RouterShutdownError } from "../../../src/services/dataplane/active-requests"
import { readRequestBody } from "../../../src/services/dataplane/body/read"

test("shutdown abort settles a stalled body read without waiting for hung cancellation", async () => {
  const abort = new AbortController()
  const entered = Promise.withResolvers<void>()
  let cancelled = 0
  let cancellationReason: unknown
  let now = 5
  const waits: number[] = []
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered.resolve()
    },
    cancel(reason) {
      cancelled++
      cancellationReason = reason
      return new Promise<void>(() => {})
    },
  })
  const add = spyOn(abort.signal, "addEventListener")
  const remove = spyOn(abort.signal, "removeEventListener")
  try {
    const reading = readRequestBody(
      { body: stream, headers: new Headers() },
      {
        signal: abort.signal,
        elapsed: () => now,
        onReadWait: (milliseconds) => waits.push(milliseconds),
      },
    )
    const outcome = reading.catch((error) => error)
    await entered.promise
    now = 17
    const reason = new RouterShutdownError()
    abort.abort(reason)
    expect(await outcome).toBe(reason)
    expect(cancelled).toBe(1)
    expect(cancellationReason).toBe(reason)
    expect(waits).toEqual([12])
    expect(stream.locked).toBe(false)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  } finally {
    add.mockRestore()
    remove.mockRestore()
  }
})
test("already aborted bodies preserve the reason without consuming bytes", async () => {
  const abort = new AbortController(),
    reason = new RouterShutdownError()
  abort.abort(reason)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(7))
    },
  })
  await expect(
    readRequestBody({ body: stream, headers: new Headers() }, { signal: abort.signal }),
  ).rejects.toBe(reason)
  expect(stream.locked).toBe(false)
  const reader = stream.getReader()
  expect((await reader.read()).value).toEqual(Uint8Array.of(7))
  await reader.cancel()
  reader.releaseLock()
})
test("normal multichunk reads preserve wire bytes/scanning and remove every read listener", async () => {
  const abort = new AbortController()
  const bytes = new TextEncoder().encode(' {"model":"fixture","unknown":"雪","stream":true} ')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1))
      controller.close()
    },
  })
  const add = spyOn(abort.signal, "addEventListener"),
    remove = spyOn(abort.signal, "removeEventListener")
  try {
    const result = await readRequestBody(
      { body: stream, headers: new Headers() },
      { signal: abort.signal },
    )
    expect(result.bytes).toEqual(bytes)
    expect(result.fields.model).toBe("fixture")
    expect(add).toHaveBeenCalledTimes(bytes.length + 1)
    expect(remove).toHaveBeenCalledTimes(bytes.length + 1)
    expect(stream.locked).toBe(false)
    abort.abort(new RouterShutdownError())
    expect(result.bytes).toEqual(bytes)
  } finally {
    add.mockRestore()
    remove.mockRestore()
  }
})
test("read errors survive cancellation cleanup and rejected cancel promises cannot replace an abort", async () => {
  const failure = new Error("fixture read failure")
  const failed = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure)
    },
  })
  await expect(
    readRequestBody(
      { body: failed, headers: new Headers() },
      { signal: new AbortController().signal },
    ),
  ).rejects.toBe(failure)
  expect(failed.locked).toBe(false)
  const abort = new AbortController(),
    entered = Promise.withResolvers<void>()
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered.resolve()
    },
    cancel() {
      return Promise.reject(new Error("cancel refused"))
    },
  })
  const reading = readRequestBody(
    { body: stream, headers: new Headers() },
    { signal: abort.signal },
  ).catch((error) => error)
  await entered.promise
  const reason = new RouterShutdownError()
  abort.abort(reason)
  expect(await reading).toBe(reason)
  expect(stream.locked).toBe(false)
})
