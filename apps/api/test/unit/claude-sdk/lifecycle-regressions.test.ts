import { describe, expect, test } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { createSdkConcurrency, createSdkInvoker, type SdkQueryFn } from "../../../src/providers"
import type { Ticker } from "../../../src/providers/claude-sdk/render"
import { wireEvent } from "./fixtures"

const start = wireEvent({
  type: "message_start",
  message: { id: "m", role: "assistant", model: "m", content: [] },
})
const cli = { ok: true, source: "platform_package", path: "/stub/claude", bytes: 1 } as const
const body = (extra: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      ...extra,
    }),
  )
const request = () => ({
  accountId: "a",
  configDir: "/isolated/a",
  model: "m",
  body: body(),
  signal: new AbortController().signal,
  session: { kind: "fresh", reason: "no-session" } as const,
})

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function settle() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
}
function ticker(): Ticker & { fire(): void } {
  const callbacks = new Set<() => void>()
  return {
    after: (_delay, callback) => {
      callbacks.add(callback)
      return () => {
        callbacks.delete(callback)
      }
    },
    fire: () => {
      for (const callback of [...callbacks]) callback()
    },
  }
}

/** A blocked SDK read settles only when the subprocess's abort signal fires. */
function stalledQuery(launches: Options[]): SdkQueryFn {
  return ({ options }) => {
    launches.push(options)
    const signal = options.abortController?.signal
    return {
      async *[Symbol.asyncIterator]() {
        yield start
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    }
  }
}

describe("terminating a streamed SDK subprocess", () => {
  for (const cause of ["idle", "cancel"] as const) {
    test(`${cause} aborts the blocked read and releases its permit`, async () => {
      const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
      const launches: Options[] = []
      const clock = ticker()
      const invoke = createSdkInvoker({
        concurrency,
        resolveCli: () => cli,
        runQuery: stalledQuery(launches),
        pacing: { idleMs: 10, heartbeatMs: 0 },
        ticker: clock,
      })
      const response = await invoke(request())
      await settle()
      expect(concurrency.inFlight).toBe(1)
      if (cause === "idle") {
        clock.fire()
        const text = await response.text()
        expect(text).toContain("event: error")
        expect(text).not.toContain("event: message_stop")
      } else {
        await response.body?.cancel("client disconnected")
      }
      await settle()
      expect(launches[0]?.abortController?.signal.aborted).toBe(true)
      expect(concurrency.inFlight).toBe(0)
    })
  }

  test("a late old-attempt cleanup cannot release the busy-session retry's permit", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const oldCleanup = gate()
    const launches: Options[] = []
    let first = true
    const runQuery: SdkQueryFn = (input) => {
      if (!first) return stalledQuery(launches)(input)
      first = false
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("Session s is currently running as a background agent")
          },
          return: async () => {
            await oldCleanup.promise
            return { done: true, value: undefined }
          },
        }),
      }
    }
    const invoke = createSdkInvoker({
      concurrency,
      resolveCli: () => cli,
      runQuery,
      pacing: { idleMs: 0, heartbeatMs: 0 },
    })
    const response = await invoke({
      ...request(),
      session: { kind: "resume", sdkSessionId: "s", lineage: "continuation", deltaFrom: 0 },
    })
    expect(concurrency.inFlight).toBe(1)
    oldCleanup.release()
    await settle()
    expect(concurrency.inFlight).toBe(1)
    expect(launches[0]?.forkSession).toBe(true)
    await response.body?.cancel()
    await settle()
    expect(concurrency.inFlight).toBe(0)
  })
})

test("invalid Messages and native tools never resolve the CLI or acquire a permit", async () => {
  const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
  let resolved = false
  let spawned = false
  const invoke = createSdkInvoker({
    concurrency,
    resolveCli: () => {
      resolved = true
      return cli
    },
    runQuery: () => {
      spawned = true
      throw new Error("unexpected dispatch")
    },
  })
  for (const invalid of [
    body({ messages: [] }),
    body({ messages: [{ role: "user", content: [{ text: "hi" }] }] }),
    body({ tools: [{ type: "web_search_20250305", name: "web_search" }] }),
    body({ tools: [{ type: "computer_20250124", name: "computer" }] }),
  ]) {
    await expect(invoke({ ...request(), body: invalid })).rejects.toThrow()
  }
  expect(resolved).toBe(false)
  expect(spawned).toBe(false)
  expect(concurrency.inFlight).toBe(0)
})
