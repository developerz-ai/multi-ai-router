import { describe, expect, test } from "bun:test"
import { observeTurn, settlesWithin } from "../../../src/providers/claude-sdk/turn-lifecycle"

/**
 * 101 finding 05.8: a turn's slot and claims were released only after the SDK iterator's
 * `return()` settled, with no bound. A CLI that ignores stdin EOF kept the permit for the process
 * lifetime. Now the close is bounded: past it the subprocess is killed and `onEnd` runs anyway.
 */

/** A source that yields `result` and whose `return()` never settles. */
function stuckSource(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => {
      let done = false
      return {
        next: async () => {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: { type: "result", subtype: "success" } }
        },
        return: () => new Promise<IteratorResult<unknown>>(() => {}),
      }
    },
  }
}

describe("a turn whose SDK iterator never closes", () => {
  test("onEnd still fires after the bound, and the subprocess is killed once", async () => {
    let ended = 0
    let killed = 0
    const turn = observeTurn(
      stuckSource(),
      {
        onFirstContent: async () => {},
        onSettled: () => {},
        onEnd: () => {
          ended++
        },
        onTeardownTimeout: () => {
          killed++
        },
      },
      20,
    )
    for await (const _ of turn) {
      /* the consumer reads to `result` */
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(killed).toBe(1)
    expect(ended).toBe(1)
  })

  test("a source that closes in time is never killed", async () => {
    let killed = 0
    let ended = 0
    const turn = observeTurn(
      (async function* () {
        yield { type: "result", subtype: "success" }
      })(),
      {
        onFirstContent: async () => {},
        onSettled: () => {},
        onEnd: () => {
          ended++
        },
        onTeardownTimeout: () => {
          killed++
        },
      },
      1_000,
    )
    for await (const _ of turn) {
      /* drain */
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ended).toBe(1)
    expect(killed).toBe(0)
  })

  test("settlesWithin answers false on expiry and true on rejection", async () => {
    expect(await settlesWithin(new Promise(() => {}), 5)).toBe(false)
    expect(await settlesWithin(Promise.reject(new Error("x")), 50)).toBe(true)
  })
})
