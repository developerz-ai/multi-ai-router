import { describe, expect, test } from "bun:test"
import { holdPrompt, observeTurn, type TurnObserver } from "../../../src/providers"

/**
 * The lifecycle around one `query()` turn (`turn-lifecycle.ts`): the prompt stays open until the
 * turn is finished with, the consumer's stream ends at `result`, and one epilogue runs exactly once
 * however the consumer let go. The usage gauge hangs off these three properties, so they are pinned
 * here rather than inferred from the invoker's behaviour.
 */

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function drain(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = []
  for await (const message of source) seen.push(message)
  return seen
}

function stream(messages: readonly unknown[]): AsyncIterable<unknown> & { returned: number } {
  const handle = {
    returned: 0,
    async *[Symbol.asyncIterator]() {
      try {
        for (const message of messages) yield message
      } finally {
        handle.returned += 1
      }
    },
  }
  return handle
}

function observer(overrides: Partial<TurnObserver> = {}) {
  const calls: string[] = []
  let settleGauge: () => void = () => {}
  const gauge = new Promise<void>((resolve) => {
    settleGauge = resolve
  })
  const seen: TurnObserver = {
    onFirstContent: () => {
      calls.push("first-content")
      return gauge
    },
    onSettled: () => calls.push("settled"),
    onEnd: () => calls.push("end"),
    ...overrides,
  }
  return { seen, calls, settleGauge }
}

const INIT = { type: "system", subtype: "init", session_id: "s" }
const CONTENT = { type: "stream_event", event: { type: "message_start" } }
const RESULT = { type: "result", subtype: "success" }

describe("the held prompt", () => {
  test("yields the one message and does not end until released", async () => {
    const held = holdPrompt([{ type: "text", text: "ping" }])
    const iterator = held.prompt[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ type: "user", parent_tool_use_id: null })

    let ended = false
    const end = iterator.next().then(() => {
      ended = true
    })
    await tick()
    expect(ended).toBe(false)

    held.release()
    held.release()
    await end
    expect(ended).toBe(true)
  })
})

describe("observing a turn", () => {
  test("ends the consumer's stream at result and runs the epilogue in order, once", async () => {
    const inner = stream([INIT, CONTENT, RESULT, { type: "system", subtype: "late" }])
    const { seen, calls, settleGauge } = observer()

    const consumed = await drain(observeTurn(inner, seen))

    expect(consumed).toEqual([INIT, CONTENT, RESULT])
    expect(calls).toEqual(["first-content"])
    // The epilogue waits for the gauge before it lets the subprocess go.
    await tick()
    expect(calls).toEqual(["first-content"])
    settleGauge()
    await tick()
    expect(calls).toEqual(["first-content", "settled", "end"])
    expect(inner.returned).toBe(1)
  })

  test("the first-content hook fires after the message was handed on, and only once", async () => {
    const order: string[] = []
    const inner = stream([INIT, CONTENT, { ...CONTENT, event: { type: "text" } }, RESULT])
    const { seen } = observer({
      onFirstContent: () => {
        order.push("hook")
        return Promise.resolve()
      },
    })

    for await (const message of observeTurn(inner, seen)) {
      order.push((message as { type: string }).type)
    }

    expect(order).toEqual(["system", "stream_event", "hook", "stream_event", "result"])
  })

  test("a turn that never answered never asks for a gauge, and still ends cleanly", async () => {
    const inner = stream([INIT])
    const { seen, calls } = observer()

    await drain(observeTurn(inner, seen))
    await tick()

    expect(calls).toEqual(["settled", "end"])
  })

  test("a consumer that lets go early still gets the one epilogue", async () => {
    const inner = stream([INIT, CONTENT, CONTENT, RESULT])
    const { seen, calls, settleGauge } = observer()
    settleGauge()

    let content = 0
    for await (const message of observeTurn(inner, seen)) {
      // The hook fires on the pull *after* the first content message — the frame is out by then —
      // so letting go on the second one is the earliest exit that has asked for a gauge.
      if ((message as { type: string }).type === "stream_event" && ++content === 2) break
    }
    await tick()

    expect(calls).toEqual(["first-content", "settled", "end"])
    expect(inner.returned).toBe(1)
  })

  test("a source that throws propagates the error and still ends exactly once", async () => {
    const inner: AsyncIterable<unknown> = {
      // biome-ignore lint/correctness/useYield: the throw is the fixture.
      async *[Symbol.asyncIterator]() {
        throw new Error("exited with code 1")
      },
    }
    const { seen, calls } = observer()

    await expect(drain(observeTurn(inner, seen))).rejects.toThrow("exited with code 1")
    await tick()

    expect(calls).toEqual(["settled", "end"])
  })
})
